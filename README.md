# mini-claw

A provider-agnostic mini Claude Code clone — a learning exercise to understand
the agentic patterns behind the real `claude-code` source. Methodology-faithful,
not feature-complete. TypeScript + Bun. Supports OpenAI and Anthropic.

## Status

Tier 1 in progress. See `docs/DESIGN.md` link in the full design doc for the
build order and stopping criteria.

## Quick start

```bash
bun install

# Choose a provider (default: anthropic)
export MINI_CC_PROVIDER=anthropic   # or: openai
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY=...

bun run src/main.ts
```

Ctrl+C aborts the current turn and returns to the prompt. Ctrl+D exits.

## Layout

```
src/
  types.ts              # neutral Message / ContentBlock / StreamEvent
  Tool.ts               # Tool interface + buildTool() factory
  QueryEngine.ts        # per-conversation state + turn loop
  prompt.ts             # system prompt assembly
  main.ts               # REPL entrypoint
  providers/
    index.ts            # LLMProvider interface + selectProvider()
    anthropic.ts        # @anthropic-ai/sdk adapter (streaming)
    openai.ts           # openai adapter (streaming)
  tools/
    read.ts write.ts edit.ts bash.ts
test/                   # mirrors src/ layout
```

## High-level architectural flow

One user prompt produces one or more sampler iterations that `QueryEngine`
drives. Text streams live; tool calls buffer until the provider finishes its
turn, then dispatch happens between sampler calls. Diagram below traces a
prompt that triggers one tool call (e.g. *"read hello.txt"*).

**Key StreamEvent types** (defined in `src/types.ts`):

- `text_delta` — a token chunk, passed straight through to stdout.
- `message_complete` — the provider finished its turn. Carries the fully
  assembled `AssistantMessage`, a `stopReason`, and token `usage`. `stopReason`
  tells `QueryEngine` what to do next:
  - `'tool_use'` — the model requested tools; dispatch them and loop.
  - `'stop'` — the turn is done; return.

```
  USER                 MAIN (REPL)                QueryEngine                    Provider                   Local
   │                        │                          │                             │                         │
   │ prompt                 │                          │                             │                         │
   ├───────────────────────►│                          │                             │                         │
   │                        │  submitMessage(text)     │                             │                         │
   │                        ├─────────────────────────►│                             │                         │
   │                        │                          │    ① engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  sampleStream(...)          │                         │
   │                        │                          ├────────────────────────────►│                         │
   │                        │                          │                             │                         │
   │                        │                          │◄─── text_delta event ───────┤   (×N)                  │
   │                        │  text_delta (yielded)    │                             │                         │
   │                        │◄─────────────────────────┤                             │                         │
   │  stdout prints         │                          │                             │                         │
   │◄───────────────────────┤                          │                             │                         │
   │                        │                          │◄── message_complete event ──┤                         │
   │                        │                          │    stopReason: 'tool_use'   │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ② engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  tool.call(input, context)  │                         │
   │                        │                          ├──────────────────────────────────────────────────────►│
   │                        │                          │                             │       execute tool:     │
   │                        │                          │                             │         Bun.file        │
   │                        │                          │                             │         Bun.spawn       │
   │                        │                          │                             │                         │
   │                        │                          │◄───────── result (string) ──────────────────────────┤
   │                        │                          │                             │                         │
   │                        │                          │    ③ engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  sampleStream(...)          │                         │
   │                        │                          ├────────────────────────────►│                         │
   │                        │                          │                             │                         │
   │                        │                          │◄─── text_delta event ───────┤   (×M)                  │
   │                        │  text_delta (yielded)    │                             │                         │
   │                        │◄─────────────────────────┤                             │                         │
   │  stdout prints         │                          │                             │                         │
   │◄───────────────────────┤                          │                             │                         │
   │                        │                          │◄── message_complete event ──┤                         │
   │                        │                          │    stopReason: 'stop'       │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ④ engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │  AsyncGenerator done     │                             │                         │
   │                        │◄─────────────────────────┤                             │                         │
   │  '> ' prompt           │                          │                             │                         │
   │◄───────────────────────┤                          │                             │                         │
```

**Engine bookkeeping** (what `QueryEngine` does between inter-actor messages):

- **①** Append `UserMessage` to `messages[]`. Create a fresh `AbortController`.
- **②** Append `AssistantMessage` (text + `ToolUse` blocks) to `messages[]`.
      Validate the tool-call input with Zod. Call `tool.checkPermissions()`.
- **③** Wrap the tool result in a `ToolResult` block. Append a `ToolMessage`
      (`role='tool'`) to `messages[]`. Re-enter the loop — next
      `sampleStream(...)` goes out with the updated history.
- **④** Append the final `AssistantMessage` to `messages[]`. Since
      `stopReason='stop'`, the loop returns and the generator ends.

**Final state of `messages[]`** — four entries, canonical transcript
invariant (see `src/types.ts`):

```
[0] UserMessage       role='user'       content=[TextBlock("read hello.txt")]
[1] AssistantMessage  role='assistant'  content=[TextBlock("Reading now."), ToolUse(Read, {...})]
[2] ToolMessage       role='tool'       content=[ToolResult("1\thello world\n")]
[3] AssistantMessage  role='assistant'  content=[TextBlock("The file says 'hello world'.")]
```

Zero tool calls (pure-text answer) collapses to `[UserMessage, AssistantMessage]`.
N tool calls expand to `[UserMessage, (AssistantMessage, ToolMessage)×N, AssistantMessage]`.
On abort at any point, the entire buffered turn is discarded back to the
pre-user-message state.

## Provider selection

- `MINI_CC_PROVIDER=anthropic` (default) — uses `ANTHROPIC_API_KEY` if set
- `MINI_CC_PROVIDER=openai` — uses `OPENAI_API_KEY` if set
- `MINI_CC_MODEL=...` — override the model (provider-specific default otherwise)
- `MINI_CC_BASE_URL=...` — API base URL. Defaults to `http://localhost:8317`
  (a local proxy). Set to `https://api.anthropic.com` or
  `https://api.openai.com/v1` to hit the real APIs directly.
  When pointed at a local proxy that doesn't require auth, the API-key env
  vars are optional — a placeholder is injected.

## Tests

```bash
bun test                              # unit + integration (fake provider)
MINI_CC_REAL_API=1 bun test test/e2e  # smoke tests against real APIs
bun run typecheck                     # tsc --noEmit
```

## Methodology references

Each module maps to a file in the real Claude Code source:

| mini-claw | real CC |
|---|---|
| `src/QueryEngine.ts` | `src/QueryEngine.ts` |
| `src/Tool.ts` | `src/Tool.ts` |
| `src/providers/*` | `src/query.ts` `callModel` + `src/services/api/` |
| `src/tools/read.ts` | `src/tools/FileReadTool/FileReadTool.ts` |
| `src/tools/write.ts` | `src/tools/FileWriteTool/FileWriteTool.ts` |
| `src/tools/edit.ts` | `src/tools/FileEditTool/FileEditTool.ts` |
| `src/tools/bash.ts` | `src/tools/BashTool/BashTool.tsx` |

We ported methodology (shape, contracts, dispatch) — not code.
