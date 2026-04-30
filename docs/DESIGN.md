# Mini Claude Code — Design

A provider-agnostic mini Claude Code clone — a learning project to understand the agentic patterns and methodology behind real `claude-code`. Methodology-faithful, not feature-complete.

This document is the canonical design spec: architecture, feature inventory with status, implementation plans for unfinished work, and the explicit out-of-scope list.

---

## Goals

- Reproduce the **shape** of real Claude Code's agent loop, tool contract, and tool implementations — not the code.
- **Provider-agnostic core.** No Anthropic-specific types cross the QueryEngine boundary; adapters translate at the edge. Currently supports OpenAI and Anthropic.
- **TypeScript + Bun** to match the real source's type system + Zod-schema + factory patterns.
- **Plain stdin/stdout REPL** — no Ink/React UI. Terminal rendering is a layer above methodology.
- Every architectural decision must trace back to a specific file:line in the real Claude Code source. "I think this would be cleaner" is not sufficient justification — mini-claw reflects real CC's choices, not improves them.

## Constraints

- **No AI-agent frameworks** (LangChain, AutoGen, Mastra). Defeats the learning goal.
- **Use official provider SDKs** (`@anthropic-ai/sdk`, `openai`) — they give types + SSE parsing + tokenizers for free.
- **Fixed dependencies:** `zod`, `commander`, `openai`, `@anthropic-ai/sdk`, `yaml`. Subprocess: `Bun.spawn`. No `execa`.
- **Simplifications are allowed; inventions are not.** When real CC doesn't support a capability, say so explicitly — don't paper over with a mini-claw-specific design.

---

## Architecture

### Neutral types

The core (`QueryEngine`, `Tool`, dispatcher) sees only neutral types from `src/types.ts`:

- `Message { role: 'user' | 'assistant' | 'tool', content: ContentBlock[] }`
- `ContentBlock = TextBlock | ToolUse | ToolResult`
- `StreamEvent = TextDelta | MessageComplete`

The `'tool'` role is mini-claw's (OpenAI-shaped) — the Anthropic adapter merges `tool` messages into `user` messages with `tool_result` content blocks at serialization time.

### Canonical transcript invariant

`messages[]` inside `QueryEngine` obeys six rules:

1. **First element:** `role='user'` (initial prompt). No `role='system'` in the array — system prompt lives outside, passed as argument to `sampleStream`.
2. **Strict alternation** after the first user message: `user → assistant → (tool → assistant → )* → user → ...`
3. An **assistant message** contains zero or more `TextBlock` and/or `ToolUse` blocks — at least one of the two (no empty assistant messages).
4. A **tool message** (`role='tool'`) contains ONLY `ToolResult` blocks.
5. **1:1 correspondence:** for each `ToolUse` in an assistant message with `stopReason='tool_use'`, the immediately-following tool message MUST contain exactly one `ToolResult` per `ToolUse`, matched by `toolUseId`. No extras. No gaps.
6. **Synthetic injections** (skill bodies) are appended as `role='user'` `TextBlock` AFTER the matching tool message — never inline with `tool_result` blocks.

**Atomicity:** a turn (assistant message + its tool message, if any) lands in `messages[]` as a unit, or not at all. Mid-stream abort drops the buffered turn — partial turns would break rule 3 (empty assistant) or rule 5 (orphan tool_use).

The rules live in `src/types.ts:6-29` and are enforced via snapshot/restore in `src/QueryEngine.ts:96-189`.

### Tool-use protocol translation

The two providers disagree on nearly every detail of tool use. Adapters translate to/from neutral types at the edge.

| Concept | Neutral | Anthropic | OpenAI |
|---|---|---|---|
| Assistant tool call | `ToolUse { id, name, input: object }` | `tool_use` block, structured `input` | `tool_calls[].function.arguments` as JSON **string** |
| Tool result | `ToolResult { toolUseId, content, isError }` | `user` message with `tool_result` block referencing `tool_use_id` | Separate message, `role: 'tool'`, `tool_call_id` |
| Roles | `user / assistant / tool` | `user / assistant` (no tool) | `user / assistant / tool / system` |
| Tool definition | `{ name, description, inputSchema (JSON Schema) }` | `{ name, description, input_schema }` | `{ type: 'function', function: { name, description, parameters } }` |
| Stop (tool call) | `'tool_use'` | `'tool_use'` | `'tool_calls'` |
| Stop (done) | `'stop'` | `'end_turn'` | `'stop'` |

**Streaming differences:**
- Anthropic streams tool input as `input_json_delta` events; the adapter assembles structured input.
- OpenAI streams tool arguments as token chunks of stringified JSON; the adapter reassembles and `JSON.parse`s.

**Adapter algorithm:**
1. **Out (neutral → provider):** for Anthropic, merge `role='tool'` messages into the previous `user` content as `tool_result` blocks. For OpenAI, emit them directly. Translate `tool.inputSchema` (Zod → JSON Schema) into provider shape.
2. **In (provider → neutral):** extract text + tool_uses from provider-specific content. For OpenAI, `JSON.parse(arguments)` with explicit error handling for malformed JSON. Normalize `stopReason` to the neutral enum.

Malformed tool-call JSON (rare, but happens) raises `ProviderProtocolError` — the loop drops the buffered turn rather than inventing a synthetic `ToolResult`.

### Agent loop

```
┌─────────────────────────────────────────────────────────────────────┐
│                         QueryEngine.submitMessage(text)             │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  Append UserMessage to        │
                    │  messages[]                   │
                    └───────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │  provider.sampleStream(       │
                    │    messages, tools,           │
                    │    systemPrompt, signal)      │
                    │  → AsyncIterable<StreamEvent> │
                    │  (adapter assembles tool      │
                    │   calls internally)           │
                    └───────────────────────────────┘
                                    │
                         ┌──────────┴──────────┐
                         │  Iterate events     │
                         └──────────┬──────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼                               ▼
              text_delta                   message_complete
         (yield live to REPL)        (assistantMessage + stopReason + usage)
                                                    │
                                                    ▼
                                    ┌────────────────────────────┐
                                    │ Append AssistantMessage to │
                                    │ messages[] (already fully  │
                                    │ assembled by adapter)      │
                                    └────────────────────────────┘
                                                    │
                            ┌───────────────────────┼───────────┐
                            ▼                       ▼           ▼
                  stopReason === 'tool_use'     'stop'        abort
                            │                       │       (AbortError)
                            ▼                       │           │
              ┌────────────────────────────┐        │           ▼
              │ For each ToolUse:          │        │   drop pending turn,
              │  1. Find tool by name      │        │   return to REPL
              │  2. Zod.validate(input)    │        │
              │  3. checkPermissions()     │        │
              │  4. tool.call(input, ctx)  │        │
              │  5. Wrap into ToolResult   │        │
              │     (catch → isError:true) │        │
              └────────────────────────────┘        │
                            │                       ▼
                            ▼               return to REPL
              ┌────────────────────────────┐
              │ Append ToolMessage with    │
              │ ToolResult blocks          │
              └────────────────────────────┘
                                        │
                                        └─────── back to sampleStream ──────┐
                                                                             │
                                                                ◀────────────┘
                                                              (next iteration)
```

### Message translation (neutral ↔ provider)

```
           OUT (neutral → provider)                  IN (provider → neutral)
  ┌─────────────────────────────────┐         ┌──────────────────────────────┐
  │ messages[]: Message[]           │         │ provider stream events       │
  │   role: user | assistant | tool │         │   (Anthropic or OpenAI SSE)  │
  └────────────┬────────────────────┘         └──────────────┬───────────────┘
               │                                             │
    ┌──────────┴──────────┐                      ┌───────────┴──────────┐
    ▼                     ▼                      ▼                      ▼
  Anthropic            OpenAI                Anthropic              OpenAI
   adapter             adapter                adapter                adapter
    │                    │                      │                      │
    ▼                    ▼                      ▼                      ▼
 merge tool msgs      emit tool msgs       content_block_*       delta.content
  into prev user       as role='tool'       events                delta.tool_calls
  as tool_result       with tool_call_id    → assemble            → reassemble
  content blocks                             ToolUse w/            stringified args
                                             structured input      → JSON.parse
                                                                   → ToolUse
               │                                             │
               ▼                                             ▼
    ┌────────────────────┐                       ┌──────────────────────┐
    │ Provider request   │                       │ StreamEvent stream   │
    │ (Anthropic/OpenAI  │                       │ (neutral shape)      │
    │  format)           │                       │                      │
    └────────────────────┘                       └──────────────────────┘
```

### QueryEngine state

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                         QueryEngine                              │
  │  ┌────────────────────────────────────────────────────────────┐  │
  │  │ messages: Message[]            (grows each turn)           │  │
  │  │ totalUsage: { in, out }         (accumulates)              │  │
  │  │ alwaysAllowed: Set<string>      (in-session permissions)   │  │
  │  │ abortController: AbortController (fresh each turn)         │  │
  │  │ provider: LLMProvider           (one, fixed per session)   │  │
  │  │ tools: Tool[]                   (one set, fixed)           │  │
  │  │ systemPrompt: string            (computed once at construct)│  │
  │  └────────────────────────────────────────────────────────────┘  │
  │                                                                  │
  │  submitMessage(text): AsyncGenerator<StreamEvent>                │
  │    ├─ creates new abortController                                │
  │    ├─ appends UserMessage                                        │
  │    ├─ runs agent loop (see diagram above)                        │
  │    └─ returns when stopReason === 'stop' OR abort                │
  └──────────────────────────────────────────────────────────────────┘
```

The `ToolContext` threaded into every `tool.call()` and `tool.checkPermissions()` carries `cwd`, `signal`, and a snapshot of the parent's `tools` (used by the Agent tool to filter the child's pool).

### Abort semantics

`AbortController` lives on `QueryEngine` and is threaded through `sampleStream()` and every `tool.call(input, ctx)`. Ctrl+C aborts the current turn:

- **Mid-stream abort:** close the provider iterator immediately. Discard the entire buffered turn — even tool_use events that completed before abort. The partial assistant message is NOT appended to `messages[]`.
- **Mid-tool-execution abort:** in-flight tools see `ctx.signal.aborted === true` and must bail within 5s. For Bash, `Bun.spawn({ signal })` sends SIGTERM; if the process doesn't exit within 5s, SIGKILL.
- **Post-abort state:** partial text already printed stays visible. `messages[]` is consistent — either the full turn landed or none of it did.

---

## Feature status

Status legend: ✅ implemented · 🟡 partial · ❌ planned · 🚫 not in scope

### Core agent loop

| Feature | Status | Pointer |
|---|---|---|
| Agent loop (sample → dispatch → repeat) | ✅ | `src/QueryEngine.ts:110-189` |
| Provider interface + adapters | ✅ | `src/providers/{index,anthropic,openai}.ts` |
| Streaming (`text_delta` + `message_complete`) | ✅ | adapter implementations |
| Neutral message types | ✅ | `src/types.ts` |
| Canonical transcript invariant enforcement | ✅ | snapshot/restore in `submitMessage` |
| Tool interface + `buildTool` factory | ✅ | `src/Tool.ts` |
| Tool dispatcher (validate → permissions → call) | ✅ | `src/QueryEngine.ts:192-293` |
| System prompt assembly | ✅ | `src/prompt.ts` |
| REPL entry | ✅ | `src/main.ts` |
| Abort handling (mid-stream + mid-tool) | ✅ | `src/QueryEngine.ts:78-80`, `src/main.ts:82-98` |

### Tools

| Tool | Status | Pointer |
|---|---|---|
| Read | ✅ | `src/tools/read.ts` |
| Write | ✅ | `src/tools/write.ts` |
| Edit | ✅ | `src/tools/edit.ts` |
| Bash | ✅ | `src/tools/bash.ts` |
| Glob | ✅ | `src/tools/glob.ts` |
| Grep | ✅ | `src/tools/grep.ts` |
| Skill (dispatcher for skills system) | ✅ | `src/tools/skill.ts` |
| Agent (dispatcher for subagents) | ✅ | `src/tools/agent.ts` |
| TodoWrite | ❌ | planned — see "Planned features" |
| EnterPlanMode / ExitPlanMode | ❌ | planned |
| MCP tools (per-server-tool wrappers) | ❌ | planned |

### Permissions

| Feature | Status | Pointer |
|---|---|---|
| Permission hook on `Tool` (`checkPermissions`) | ✅ | `src/Tool.ts:82-85` |
| Interactive y/n/always-allow prompts | ✅ | `src/permissions.ts` |
| In-session "always allow" cache | ✅ | `alwaysAllowed: Set<string>` in `QueryEngine` |
| Plan-mode permission gating | ❌ | planned |
| Hook callouts (PreToolUse / PostToolUse) | ❌ | planned |
| Cross-session permission persistence | 🚫 | not in scope |
| Wildcard / glob permission rules | 🚫 | not in scope |
| Bash command classifier (whitelist) | 🚫 | not in scope |

### Extensibility

| Feature | Status | Pointer |
|---|---|---|
| Skills (markdown bundles, dispatcher tool, body injection) | ✅ | `src/skills/loader.ts`, `src/tools/skill.ts` |
| Subagents (per-persona child engine) | ✅ | `src/agents/loader.ts`, `src/tools/agent.ts` |
| Built-in agent presets (`general-purpose`, `Explore`) | ❌ | planned |
| MCP integration | ❌ | planned |
| Plugin bundles (skills + agents + MCP) | ❌ | planned |
| Hooks (pre/post tool, session start) | ❌ | planned |
| Context compaction | ❌ | planned |
| Parallel tool execution | ❌ | planned |
| Slash commands framework | 🚫 | not in scope (skills cover the same pattern) |
| Ink/React UI | 🚫 | not in scope |
| LSP / IDE bridge | 🚫 | not in scope |
| Worktrees / coordinator / remote sessions | 🚫 | not in scope |

### Conversation lifecycle

| Feature | Status | Pointer |
|---|---|---|
| Multi-turn conversation | ✅ | `messages[]` persists across `submitMessage` |
| Token usage accumulator | 🟡 | `totalUsage` accumulates but isn't surfaced in REPL |
| JSONL session persistence | 🚫 | not in scope |
| `--resume` flag | 🚫 | not in scope |

---

## Planned features

Detailed implementation plans for everything marked ❌ above. Build order at the bottom of this section is smallest-first to keep momentum and validate engine assumptions before the heavy lifts.

### Built-in agent presets

Real CC ships `general-purpose`, `Explore`, and `Plan` as built-in agent presets. Mini-claw should ship `general-purpose` and `Explore`.

**Design:**
- `general-purpose` — full tool pool (`tools: undefined`), generic research/planning persona. Implicit default when `subagent_type` is omitted.
- `Explore` — read-only allowlist (`tools: ['Read', 'Glob', 'Grep']`), exploration-focused persona. Short body (~30 lines) focused on read-only investigation.

**Files to create:**
- `src/agents/builtIn.ts` — exports `BUILT_IN_AGENTS: AgentDefinition[]`

**Files to modify:**
- `src/agents/loader.ts` — after the project+user merge in `loadAgents()`, append built-ins to the byType map only when the key isn't already present (priority: project > user > built-in, mirrors `../claude-code/src/tools/AgentTool/loadAgentsDir.ts:193-227`)
- `src/tools/agent.ts:128-148` (`resolveAgent`) — when `subagent_type` is omitted, default to `general-purpose` if available (mirrors `../claude-code/src/tools/AgentTool/AgentTool.tsx:322`)
- `src/agents/loader.ts:33-37` — drop "built-in agents" from the deliberate-skip list

**LOC:** ~50–80.

**Real CC anchor:** `../claude-code/src/tools/AgentTool/builtInAgents.ts`

### Parallel tool execution

When the assistant returns multiple `ToolUse` blocks AND all are `isConcurrencySafe`, run via `Promise.all` with order-preserved results. Otherwise sequential.

**Design:**

`isConcurrencySafe` already exists on every tool (`src/Tool.ts:90`); the dispatch loop is sequential today (`src/QueryEngine.ts:159-168`).

Audit per tool:
- `isConcurrencySafe: true` — Read, Glob, Grep (read-only)
- `isConcurrencySafe: false` (default) — Write, Edit, Bash, TodoWrite, Skill, Agent

**Files to modify:**
- `src/QueryEngine.ts:159-168` — replace sequential `for` loop with branching:
  ```ts
  const allSafe = toolUses.every(tu => {
    const t = this.tools.find(tt => tt.name === tu.name);
    return t?.isConcurrencySafe === true;
  });
  const dispatchResults = allSafe
    ? await Promise.all(toolUses.map(tu => this.dispatchTool(tu, ctx)))
    : await sequentialDispatch(toolUses, tu => this.dispatchTool(tu, ctx));
  ```
- Per-tool: explicitly set `isConcurrencySafe: true` on Read/Glob/Grep (default is `false`)

`Promise.all` preserves call order in the result array, so `toolResults[]` indexes still match `toolUses[]`. Skill injections accumulate in original-call order.

**LOC:** ~80.

### TodoWrite

Tool with persistent state for task tracking. Demonstrates a pattern not present elsewhere in the code: tool-owned disk persistence.

**Design:**

Tool input:
```ts
TodoWriteInput = z.object({
  todos: z.array(z.object({
    content: z.string(),                         // imperative: "Run tests"
    status: z.enum(['pending', 'in_progress', 'completed']),
    activeForm: z.string(),                      // continuous: "Running tests"
  })),
})
```

Storage: `.mini-cc/todos.json` (project-scoped — matches the `.mini-cc` convention used elsewhere). Whole-list overwrite per call; no per-item upsert. Add to `.gitignore`.

**Invariant:** at most one todo with `status === 'in_progress'` at any time. Reject otherwise via `isError: true`.

**Files to create:**
- `src/tools/todoWrite.ts` — `buildTool` with `name: 'TodoWrite'`, `isReadOnly: false`, `isDestructive: false`
- `test/tools/todoWrite.test.ts`

**Files to modify:**
- `src/tools/index.ts` — append `todoWriteTool` to `DEFAULT_TOOLS`

**LOC:** ~150 including tests.

**Real CC anchor:** `../claude-code/src/tools/TodoWriteTool/TodoWriteTool.ts`

### Plan mode

`EnterPlanMode` / `ExitPlanMode` tools toggle a session-wide mode. While in plan mode, Write/Edit/Bash deny via `checkPermissions`; Read/Glob/Grep continue to work.

**Design:**

Engine state: `private mode: 'default' | 'plan' = 'default'` on `QueryEngine`. Per-turn `ToolContext` carries `mode` and a callback `setMode(m)`. The mode field is engine-scoped — once entered, stays on across turns until `ExitPlanMode`.

**Files to modify:**
- `src/Tool.ts:19-23` — add `mode: 'default' | 'plan'` and `setMode?: (m: 'default' | 'plan') => void` to `ToolContext`
- `src/QueryEngine.ts` — add `mode` field, populate `ctx.mode`, expose `setMode` callback for plan-mode tools
- `src/tools/{write,edit,bash}.ts` — in `checkPermissions(input, ctx)`, deny when `ctx.mode === 'plan'` with reason `"Plan mode is on; this tool is unavailable until you exit plan mode."`
- `src/main.ts` — show plan-mode indicator in the readline prompt (e.g. `⏸  > ` vs `> `)
- `src/prompt.ts` — add a one-line note about plan-mode semantics

**Files to create:**
- `src/tools/enterPlanMode.ts` — no input; `call(_, ctx)` invokes `ctx.setMode?.('plan')`
- `src/tools/exitPlanMode.ts` — symmetric

**LOC:** ~120.

**Real CC anchors:**
- `../claude-code/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts`
- `../claude-code/src/tools/ExitPlanModeTool/ExitPlanModeTool.ts`

### Hooks (pre/post tool, session start)

User-configurable shell commands that run before/after tool calls and at session start. Introduces the harness/engine boundary — a pattern not yet present in mini-claw.

**Config format** (`./.mini-cc/hooks.json` and `~/.mini-cc/hooks.json`, project priority):
```json
{
  "PreToolUse": [
    { "matcher": "Bash", "command": "echo \"⚠ about to run: $TOOL_INPUT\" >&2", "timeoutMs": 10000 }
  ],
  "PostToolUse": [
    { "matcher": "Write|Edit", "command": "yarn lint --fix", "timeoutMs": 30000 }
  ],
  "SessionStart": [
    { "command": "git log --oneline -5" }
  ]
}
```

**Events:**
- `SessionStart` — at REPL boot, before the first prompt. Once per session.
- `PreToolUse` — after `checkPermissions` returns allow, before `tool.call()`. Non-zero exit treated as `{ deny, reason: 'PreToolUse hook rejected' }`.
- `PostToolUse` — after `tool.call()` returns, before `ToolResult` is appended. Stdout captured into a `[hook]` suffix on the ToolResult content.

**Match semantics:** `matcher` is a regex against tool name. Missing matcher = match all. Multiple hooks per event run sequentially in array order.

**Files to create:**
- `src/hooks/loader.ts` — read project + user `hooks.json`, merge, validate shape
- `src/hooks/runner.ts` — `runHooks(event, { toolName, toolInput }) → Promise<HookResult>`. Spawns each hook via `Bun.spawn` with `TOOL_NAME`, `TOOL_INPUT` (JSON), `EVENT` env vars. Default 10s timeout; SIGTERM on overflow, log warning, treat as no-op.

**Files to modify:**
- `src/QueryEngine.ts` — call `runHooks('PreToolUse', ...)` between `checkPermissions` and `tool.call()`; call `runHooks('PostToolUse', ...)` after `tool.call()` returns
- `src/main.ts` — call `runHooks('SessionStart')` once at REPL boot

**LOC:** ~300.

**Real CC anchor:** `../claude-code/src/hooks/`

### Context compaction

When token usage exceeds a threshold (default 70% of model context window), spawn a "summarize this conversation" subagent over the older half of `messages[]` and replace it with a single summary message.

**Design:**

Two phases:

**Phase A — tokenizers:**
- Add `countTokens(text: string): Promise<number>` to `LLMProvider` interface (`src/providers/index.ts:31-40`)
- Anthropic: `@anthropic-ai/tokenizer` (model-aware)
- OpenAI: `tiktoken` (per-model encoder, cached)

**Phase B — compaction:**
- `src/services/compact.ts` — exports `maybeCompact(engine, opts)`. Sums `messages[]` text + tool_result content via `countTokens`, compares to threshold, on overflow spawns a child engine with a summarizer persona over the older half, drains to text, replaces `messages[]` with `[summaryAsUserMessage, ...recentHalf]`.
- Call site: `src/QueryEngine.ts:111` (top of the loop), once per turn before `sampleStream`. Returns silently on no-op.

**Invariant note:** the post-compaction `messages[]` still starts with `role='user'` — the summary message takes index 0 as a synthesized user message. Document this relaxation of rule 1 in `src/types.ts`.

The summarizer reuses Agent tool plumbing — `assembleChildSystemPrompt` shape works as-is, with a "summarize this conversation faithfully" body.

**Dependencies to add:** `@anthropic-ai/tokenizer`, `tiktoken`.

**LOC:** 300–500. Heaviest single feature.

**Real CC anchors:** `../claude-code/src/services/compact/`, `../claude-code/src/query/`

### MCP integration

The Model Context Protocol is an open standard for clients to connect to external **tool servers** over JSON-RPC 2.0. Each server advertises tools, resources, and prompts. The client wraps server tools as callable functions identical in shape to local tools.

**MVP scope:** stdio transport only, tools-only (skip resources/prompts), no OAuth.

**Architecture:**

```
┌────────────────┐                  ┌─────────────────┐
│  mini-claw     │   JSON-RPC 2.0   │  MCP server     │
│  (parent)      │◄────────────────►│  (subprocess)   │
│                │   over stdio     │                 │
│  ┌──────────┐  │                  │  e.g.           │
│  │ MCPClient│──┘                  │  @playwright    │
│  │ (per     │                     │  /mcp           │
│  │  server) │                     │                 │
│  └──────────┘                     └─────────────────┘
│       │
│       │ wraps each tool from listTools() into:
│       ▼
│   buildTool({
│     name: 'mcp__<server>__<tool>',
│     inputSchema: <translated from server's JSON Schema>,
│     call: (input, ctx) => client.callTool({ name, arguments: input })
│   })
```

**Config format** (`./.mini-cc/mcp.json` and `~/.mini-cc/mcp.json`, project priority):
```json
{
  "servers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

**Files to create:**
- `src/mcp/loader.ts` — load + parse `mcp.json` from project + user dirs (mirror the skills/agents loader pattern)
- `src/mcp/client.ts` — wrap `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`. Connect, `listTools()`, return tool descriptors
- `src/mcp/connectionManager.ts` — orchestrate one client per server. Connect-all at boot; tear-down-all on REPL exit (handle Ctrl+C cleanup)
- `src/mcp/toolFactory.ts` — given a server name + tool descriptor, return a mini-claw `Tool` whose `call()` proxies to the client. Naming: `mcp__<server>__<toolname>` (matches real CC)
- `src/mcp/jsonSchemaToZod.ts` — server returns JSON Schema; `inputSchema` wants Zod. Use `zod-from-json-schema` or hand-roll a minimal subset (object + primitives are enough for MVP)

**Files to modify:**
- `src/main.ts` — alongside `loadSkills` + `loadAgents`, add `loadMCPServers({ cwd })` in the same `Promise.all`. Append all MCP tools to the `tools[]` array. Register `process.on('exit', () => connectionManager.shutdown())` so subprocesses don't leak
- `src/skills/loader.ts:19-23` and `src/agents/loader.ts:33-37` — drop "MCP" from the deliberate-skip list

**Dependencies to add:** `@modelcontextprotocol/sdk`.

**Permissions:** each MCP tool routes through the same `checkPermissions` hook. Default behavior: `{ behavior: 'ask' }`. The "always allow" cache keys off the full `mcp__<server>__<tool>` name — accepting one tool from a server doesn't accept all.

**Out of MVP scope:**
- OAuth flows (start with no-auth servers)
- SSE / streamable HTTP transports (stdio only)
- Resources (`ListMcpResourcesTool`, `ReadMcpResourceTool`)
- Prompts (server-side templates)
- Dynamic registry browsing
- Per-channel allowlists
- Elicitation (server → client questions)
- Deferred schema loading (load all schemas at boot)

**LOC:** 400–600.

**Real CC anchors:**
- `../claude-code/src/services/mcp/` (19 files)
- `../claude-code/src/services/mcp/client.ts`
- `../claude-code/src/tools/MCPTool/MCPTool.ts`

**Stopping criteria:** `mcp.json` with one stdio server (e.g. Playwright) loads at boot, registers tools, the model invokes them like local tools, REPL exit cleanly tears down subprocesses.

### Plugin bundles

A plugin is a directory bundle that ships skills + agents + MCP server registrations as one installable unit. Builds directly on the loader patterns from skills, subagents, and MCP.

**Plugin layout:**
```
.mini-cc/plugins/<plugin-name>/
├── plugin.json              # manifest
├── skills/
│   └── <skill>/SKILL.md
├── agents/
│   └── <agent>.md
└── mcp.json                 # bundled MCP server registrations
```

User-level plugins: `~/.mini-cc/plugins/<plugin-name>/`.

**Manifest:**
```json
{
  "name": "playwright-bundle",
  "version": "0.1.0",
  "description": "Playwright browser automation skills + MCP server",
  "skills": ["browse-page", "screenshot"],
  "agents": ["browser-explorer"],
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }
  }
}
```

**Files to create:**
- `src/plugins/loader.ts` — walks `.mini-cc/plugins/*/plugin.json` (project) and `~/.mini-cc/plugins/*/plugin.json` (user), parses manifests, validates shape
- `src/plugins/aggregator.ts` — given `Plugin[]`, calls into `loadSkills`, `loadAgents`, `loadMCPServers` with the plugin's subdirectories as additional roots. Aggregates everything into the regular flat lists. Priority: project standalone > project plugin > user standalone > user plugin > built-in

**Files to modify:**
- `src/skills/loader.ts:68-93` — generalize `loadSkills()` to accept `extraRoots: string[]`
- `src/agents/loader.ts:100-121` — same generalization
- `src/mcp/loader.ts` — accept `extraConfigs: McpConfig[]`
- `src/main.ts` — call `loadPlugins({ cwd })` first, then derive `extraRoots`/`extraConfigs` for the skill/agent/MCP loaders

**Out of MVP scope:** plugin marketplace / registry / install commands, version resolution, hook events from plugins, signing / sandboxing, per-plugin permission scopes.

**LOC:** 200–300.

**Real CC anchors:**
- `../claude-code/src/plugins/`
- `../claude-code/src/services/plugins/`

**Stopping criteria:** a `.mini-cc/plugins/<name>/` containing a SKILL.md, an agent file, and `mcp.json` loads correctly at boot; its skills/agents/MCP tools appear in the regular listings; first-wins dedup works across plugin/standalone boundaries.

### Build order

Smallest-first, dependencies last:

1. **Built-in agent presets** — ~50 LOC. Closes the canonical "Explore subagent" success criterion.
2. **Parallel tool execution** — ~80 LOC. Pure dispatcher change.
3. **TodoWrite** — ~150 LOC. Standalone. First "tool with persistent state" lesson.
4. **Plan mode** — ~120 LOC. Validates the engine→tool callback pattern.
5. **Hooks** — ~300 LOC. Introduces the harness/engine boundary.
6. **Context compaction** — 300–500 LOC. Tokenizer dep + summarizer subagent. Optionally split into Phase A (tokenizers) and Phase B (compaction trigger + summarizer).
7. **MCP integration** — 400–600 LOC. Tool extensibility capstone.
8. **Plugin bundles** — 200–300 LOC. Bundle layer over Skills + Agents + MCP. Depends on MCP.

---

## Not in scope

Features deliberately not implemented. The bar to bring any of these in is a clear pedagogical payoff (a new pattern not learnable from anything already shipped) plus a cost we can stomach.

**Conversation lifecycle**
- JSONL session persistence (`.mini-cc/sessions/{id}.jsonl`)
- In-REPL token/cost printing (`totalUsage` accumulates but isn't surfaced)
- `mini-cc --resume {id}` CLI flag

**Permissions**
- AskUserQuestion tool (interactive-flow learning is covered by `permissionPrompter`)
- Permission wildcards + cross-session `settings.json` persistence
- Bash command classifier (whitelist of safe commands)

**UI / IDE / extensibility (beyond MCP + Plugins)**
- LSP integration, IDE bridge, slash-commands framework, Ink/React UI, file-history/git-diff tracking, notebook/PDF/image support, coordinator mode, worktrees, remote sessions, cron, upstream proxy, voice, vim, custom keybindings, output styles, analytics/telemetry

---

## Success criteria

**Core loop:**
- A cold REPL session can read a file, write a new file, edit an existing file, and run a shell command — all driven by the LLM, no provider-specific code in the core
- Swapping `ANTHROPIC_API_KEY` for `OPENAI_API_KEY` plus flipping `MINI_CC_PROVIDER` runs the exact same agent with the exact same tools
- No `@anthropic-ai/sdk` types imported outside `src/providers/anthropic.ts`; no `openai` types imported outside `src/providers/openai.ts`
- Adapter unit tests pass against pre-recorded SSE fixtures (both providers → identical neutral output)
- E2E smoke (`MINI_CC_REAL_API=1`) passes against both providers
- Permission prompts work; in-session "always allow" is honored

**Extensibility:**
- Subagent spawn: the main agent dispatches an `Explore` subagent with read-only tools and gets its summary back as a tool result
- Skills: `*/SKILL.md` files load, parse frontmatter, are invokable via the `Skill` tool
- TodoWrite, plan mode, parallel tools, compaction, and hooks all working
- MCP: `mcp.json` with one stdio server loads, registers tools, model invokes them, REPL exit cleans up subprocesses
- Plugins: a `.mini-cc/plugins/<x>/` bundle exposes its skills/agents/MCP as if standalone, with first-wins dedup against standalone definitions

**Overall done when** a reader can say: *"I understand how Claude Code works end-to-end. When I read a new CC feature, I know where it hooks in."*

---

## References

- Real Claude Code source (read-only reference for citations): `../claude-code/src/`
- In-repo flow diagrams (skill loading + invocation, subagent loading + invocation): [`README.md`](../README.md)
