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
