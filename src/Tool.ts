import { z } from 'zod';

/**
 * Runtime context threaded into every Tool.call() and Tool.checkPermissions().
 *
 * - `cwd` is fixed at QueryEngine construction (Tier 1 has no mid-session cd).
 * - `signal` is the per-turn AbortSignal. Tools MUST honor this and bail
 *   within 5 seconds of abort or the dispatcher will treat them as hard-killed
 *   (for Bash: SIGTERM, then SIGKILL after 5s).
 */
export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

/**
 * Permission hook result. Dispatcher calls `checkPermissions()` BEFORE `call()`
 * and maps the result:
 *   - `allow` → proceed to call()
 *   - `deny`  → synthesize ToolResult { isError: true, content: "Permission denied: {reason}" }
 *   - `ask`   → (Tier 2) prompt user on stdin; Tier 1 treats as allow
 */
export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; prompt: string };

/**
 * A tool the LLM can invoke. Parameterized by the Zod schema for its input —
 * the dispatcher validates raw JSON input against `inputSchema` before calling
 * `call()`, so `call()` can trust the typed input.
 *
 * `call()` returns a string (Tier 1 keeps this simple; widen to
 * `string | ContentBlock[]` if a tool ever needs structured output).
 */
export interface Tool<I extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: I;

  call(input: z.infer<I>, ctx: ToolContext): Promise<string>;

  /**
   * Permission hook. Defaults (via buildTool) to always-allow in Tier 1.
   * Tier 2 will implement real prompts for Write / Edit / Bash.
   */
  checkPermissions(
    input: z.infer<I>,
    ctx: ToolContext,
  ): Promise<PermissionResult>;

  /** Tool reads state only; safe side-effect-free. */
  isReadOnly: boolean;
  /** Multiple invocations can safely run in parallel (Tier 3 uses this). */
  isConcurrencySafe: boolean;
  /** Side effects may be irreversible (Write, Edit, Bash). */
  isDestructive: boolean;
}

type ToolDef<I extends z.ZodTypeAny> = Pick<
  Tool<I>,
  'name' | 'description' | 'inputSchema' | 'call'
> &
  Partial<Pick<Tool<I>, 'checkPermissions' | 'isReadOnly' | 'isConcurrencySafe' | 'isDestructive'>>;

/**
 * Build a Tool from a partial definition, merging Tier 1 defaults.
 *
 * Defaults are conservative (opt-in for ReadOnly / ConcurrencySafe;
 * ConcurrencySafe defaults false because sharing filesystem/shell state by
 * default is unsafe). Destructive defaults false — tools that mutate should
 * set it explicitly.
 */
export function buildTool<I extends z.ZodTypeAny>(def: ToolDef<I>): Tool<I> {
  return {
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    checkPermissions: async () => ({ behavior: 'allow' }),
    ...def,
  };
}
