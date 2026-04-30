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

## Skill loading and invoking

Skills are markdown bundles loaded at REPL startup, advertised via the
system prompt, and invoked through a single dispatcher tool whose `call()`
returns the skill body as a follow-up *user* message — the `newMessages`
injection pattern from real CC (`SkillTool.ts:291-298` for the dispatcher
schema; `SkillTool.ts:728-755` for the injection mechanism).

### Phase 1 — loading (at startup)

```
  MAIN (startup)              SkillLoader                FileSystem
       │                            │                         │
       │  loadSkills({ cwd })       │                         │
       ├───────────────────────────►│                         │
       │                            │  readdir                │
       │                            │   ./.mini-cc/skills/    │
       │                            ├────────────────────────►│
       │                            │◄────── entries ─────────┤
       │                            │  readdir                │
       │                            │   ~/.mini-cc/skills/    │
       │                            ├────────────────────────►│
       │                            │◄────── entries ─────────┤
       │                            │                         │
       │                            │  for each entry that    │
       │                            │  contains SKILL.md:     │
       │                            │    Bun.file(SKILL.md)   │
       │                            ├────────────────────────►│
       │                            │◄──── markdown text ─────┤
       │                            │    parseSkillFile       │
       │                            │     (YAML + body)       │
       │                            │                         │
       │                            │  dedup: project > user  │
       │                            │  sort by name           │
       │◄────── Skill[] ────────────┤                         │
       │                            │                         │
       │  buildSkillTool(skills)    │                         │
       │  assembleSystemPrompt({    │                         │
       │    tools, skills, ... })   │                         │
       │  new QueryEngine({         │                         │
       │    tools, systemPrompt })  │                         │
```

Notes:
- Project beats user on name conflict — first-wins dedup matches real CC
  (`loadSkillsDir.ts:753-762`).
- Missing `description` falls back to the first non-heading line of the
  body (real CC: `loadSkillsDir.ts:208-214`).
- The `Skill` tool is registered alongside `DEFAULT_TOOLS` only when
  `skills.length > 0` — keeps the catalog clean for sessions with no
  skills installed.
- Skill **bodies** are NOT in the system prompt. The system prompt only
  carries a `# Available skills` listing (name + description + optional
  `when_to_use`); bodies live in the in-memory `Skill[]` and are spliced
  into the conversation on demand. That's what keeps the system prompt
  cacheable across turns.

### Phase 2 — invocation (per turn)

The model invokes a skill by calling `Skill(skill="<name>", args="<string>")`.
The dispatcher renders the body (`$ARGUMENTS` + `$SKILL_DIR` substitution),
returns a one-line `tool_result` ("Launching skill: …"), AND emits a
follow-up user message carrying the rendered body. Diagram traces a turn
that activates `write-greeting` and ends after one downstream tool call;
real flows typically iterate further (e.g. Bash on `$SKILL_DIR/validate.sh`).

```
  USER                 MAIN (REPL)                QueryEngine                    Provider                   Local
   │                        │                          │                             │                         │
   │ prompt mentioning      │                          │                             │                         │
   │ a skill                │                          │                             │                         │
   ├───────────────────────►│                          │                             │                         │
   │                        │  submitMessage(text)     │                             │                         │
   │                        ├─────────────────────────►│                             │                         │
   │                        │                          │    ① engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  sampleStream(...)          │                         │
   │                        │                          ├────────────────────────────►│                         │
   │                        │                          │                             │                         │
   │                        │                          │◄── message_complete event ──┤                         │
   │                        │                          │    stopReason: 'tool_use'   │                         │
   │                        │                          │    ToolUse(Skill,           │                         │
   │                        │                          │      { skill, args })       │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ② engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  Skill.call(input, ctx)     │                         │
   │                        │                          │  (in-process; renders body, │                         │
   │                        │                          │   returns content +         │                         │
   │                        │                          │   injections[])             │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ③ engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  sampleStream(...)          │                         │
   │                        │                          ├────────────────────────────►│                         │
   │                        │                          │                             │                         │
   │                        │                          │◄── message_complete event ──┤                         │
   │                        │                          │    stopReason: 'tool_use'   │                         │
   │                        │                          │    ToolUse(Write, {...})    │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ④ engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │                          │  tool.call(input, ctx)      │                         │
   │                        │                          ├──────────────────────────────────────────────────────►│
   │                        │                          │                             │     Bun.write(...)      │
   │                        │                          │◄────────── result ─────────────────────────────────────┤
   │                        │                          │                             │                         │
   │                        │                          │    ⑤ ... iterations         │                         │
   │                        │                          │       continue while model  │                         │
   │                        │                          │       follows skill body    │                         │
   │                        │                          │                             │                         │
   │                        │                          │  sampleStream(...)          │                         │
   │                        │                          ├────────────────────────────►│                         │
   │                        │                          │◄── message_complete event ──┤                         │
   │                        │                          │    stopReason: 'stop'       │                         │
   │                        │                          │                             │                         │
   │                        │                          │    ⑥ engine bookkeeping     │                         │
   │                        │                          │                             │                         │
   │                        │  AsyncGenerator done     │                             │                         │
   │                        │◄─────────────────────────┤                             │                         │
   │  '> ' prompt           │                          │                             │                         │
   │◄───────────────────────┤                          │                             │                         │
```

**Engine bookkeeping** (same shape as the per-tool flow above; the special
case is ③):

- **①** Append `UserMessage` to `messages[]`. Create a fresh `AbortController`.
- **②** Append `AssistantMessage` (`ToolUse(Skill, ...)`). Validate input
      with Zod. Call `Skill.checkPermissions()`.
- **③** **Skill dispatch is the special case.** `Skill.call()` runs entirely
      in-process: resolves the named skill from the in-memory map, calls
      `render(skill, args)` which substitutes `$ARGUMENTS` and `$SKILL_DIR`
      in the body, and returns
      `{ content: "Launching skill: …", injections: [{ role: 'user', text: <body> }] }`.
      The dispatcher then **appends a `ToolMessage`** with the one-line
      `ToolResult` (completing the 1:1 `tool_use ↔ tool_result` pairing
      required by the canonical transcript invariant — `src/types.ts`
      rule 5) — AND **appends a separate `UserMessage`** carrying the
      injection text. Order is load-bearing: the ToolMessage MUST come
      first; the injection arrives AFTER as a fresh user message, never
      folded into the ToolMessage.
- **④** Standard tool dispatch. Skill body typically directs the model to
      call `Write`, `Bash` (e.g. on bundled scripts referenced via
      `$SKILL_DIR`), etc. Each runs through the normal path with its own
      permission checks.
- **⑤** Iterations continue. The skill body remains visible in `messages[]`
      for every subsequent sample call — that's why we never need to
      re-inject.
- **⑥** Final `AssistantMessage` with `stopReason='stop'`. Loop returns.

**Final state of `messages[]`** — illustrative for `write-greeting` → Write →
Bash → text:

```
[0] UserMessage       content=[TextBlock("Use write-greeting on /tmp/x.txt")]
[1] AssistantMessage  content=[ToolUse(Skill, { skill: 'write-greeting', args: '/tmp/x.txt' })]
[2] ToolMessage       content=[ToolResult("Launching skill: write-greeting")]
[3] UserMessage       content=[TextBlock(<rendered SKILL.md body>)]                    ← injection
[4] AssistantMessage  content=[ToolUse(Write, { file_path: '/tmp/x.txt', content: 'Hello, …!' })]
[5] ToolMessage       content=[ToolResult("ok")]
[6] AssistantMessage  content=[ToolUse(Bash, { command: 'bash $SKILL_DIR/validate.sh /tmp/x.txt' })]
[7] ToolMessage       content=[ToolResult(<bash output>)]
[8] AssistantMessage  content=[TextBlock("Wrote the greeting to /tmp/x.txt.")]
```

The injection at `[3]` is the load-bearing piece: skill content arrives
in-conversation, on demand, without ever mutating the system prompt. That
keeps the system prompt cacheable across turns and matches real CC's
`newMessages` mechanism (`SkillTool.ts:728-755`).

## Subagent loading and invoking

Subagents are markdown-defined personas loaded at REPL startup, advertised
via the system prompt, and invoked through a single dispatcher tool whose
`call()` **spawns a fresh `QueryEngine`** with isolated state — its own
`messages[]`, its own system prompt (the agent body, not the parent's
persona), and a filtered tool pool. The child runs to completion; only the
final assistant text bubbles back to the parent as the `tool_result`
content (real CC: `tools/AgentTool/AgentTool.tsx:82-87` for the schema,
`tools/AgentTool/agentToolUtils.ts:297-356` for the result extraction).

**Contrast with skills.** Both are markdown + single-dispatcher, but the
result mechanism differs:

| | Skill | Subagent |
|---|---|---|
| Body delivery | Injected as a follow-up `UserMessage` in the parent's history | Stays inside the child; never appears in the parent |
| Parent transcript shape | `[user, asst, tool, **user (injection)**, ...]` | `[user, asst, tool, asst]` — same as a vanilla tool call |

### Phase 1 — loading (at startup)

```
  MAIN (startup)              AgentLoader               FileSystem
       │                            │                         │
       │  loadAgents({ cwd })       │                         │
       ├───────────────────────────►│                         │
       │                            │  readdir                │
       │                            │   ./.mini-cc/agents/    │
       │                            ├────────────────────────►│
       │                            │◄────── entries ─────────┤
       │                            │  readdir                │
       │                            │   ~/.mini-cc/agents/    │
       │                            ├────────────────────────►│
       │                            │◄────── entries ─────────┤
       │                            │                         │
       │                            │  for each *.md file:    │
       │                            │    Bun.file(...).text() │
       │                            ├────────────────────────►│
       │                            │◄──── markdown text ─────┤
       │                            │    parseAgentFile       │
       │                            │     (YAML + body)       │
       │                            │     parseAgentTools     │
       │                            │                         │
       │                            │  dedup: project > user  │
       │                            │  sort by agentType      │
       │◄── AgentDefinition[] ──────┤                         │
       │                            │                         │
       │  register Agent tool;      │                         │
       │  list agents in            │                         │
       │  system prompt             │                         │
```

Notes:
- One markdown file per agent (`<slug>.md`); the filename stem is the
  `agentType` the model passes as `subagent_type`.
- Project beats user on conflict — first-wins dedup, same as skills.
- Agent **bodies** are NOT in the parent's system prompt — only a short
  `# Available agents` listing (agentType + whenToUse). Bodies are
  reserved for the *child's* system prompt at spawn time.

### Phase 2 — invocation, parent's view

The model invokes a subagent with
`Agent({ description, prompt, subagent_type })`. From the parent's side
this is a normal tool call: `ToolUse(Agent) → ToolMessage → final text`.
The novelty is that `Agent.call()` doesn't hit the filesystem or the
network — it spawns a child engine (see Phase 3).

```
  USER                 MAIN (REPL)                Parent QE                       Provider                  Agent.call
   │                        │                          │                              │                          │
   │ prompt asking          │                          │                              │                          │
   │ for delegated work     │                          │                              │                          │
   ├───────────────────────►│                          │                              │                          │
   │                        │  submitMessage(text)     │                              │                          │
   │                        ├─────────────────────────►│                              │                          │
   │                        │                          │    ① engine bookkeeping      │                          │
   │                        │                          │                              │                          │
   │                        │                          │  sampleStream(...)           │                          │
   │                        │                          ├─────────────────────────────►│                          │
   │                        │                          │◄── message_complete event ───┤                          │
   │                        │                          │    stopReason: 'tool_use'    │                          │
   │                        │                          │    ToolUse(Agent, {          │                          │
   │                        │                          │      description, prompt,    │                          │
   │                        │                          │      subagent_type           │                          │
   │                        │                          │    })                        │                          │
   │                        │                          │                              │                          │
   │                        │                          │    ② engine bookkeeping      │                          │
   │                        │                          │                              │                          │
   │                        │                          │  Agent.call(input, ctx)      │                          │
   │                        │                          ├─────────────────────────────────────────────────────────►│
   │                        │                          │                              │   (in-process; spawns    │
   │                        │                          │                              │    a Child QueryEngine — │
   │                        │                          │                              │    see Phase 3)          │
   │                        │                          │◄────── { content: <child's last assistant text> } ───────┤
   │                        │                          │                              │                          │
   │                        │                          │    ③ engine bookkeeping      │                          │
   │                        │                          │                              │                          │
   │                        │                          │  sampleStream(...)           │                          │
   │                        │                          ├─────────────────────────────►│                          │
   │                        │                          │◄─── text_delta event ────────┤   (×N)                   │
   │                        │  text_delta (yielded)    │                              │                          │
   │                        │◄─────────────────────────┤                              │                          │
   │ stdout prints          │                          │                              │                          │
   │◄───────────────────────┤                          │                              │                          │
   │                        │                          │◄── message_complete event ───┤                          │
   │                        │                          │    stopReason: 'stop'        │                          │
   │                        │                          │                              │                          │
   │                        │                          │    ④ engine bookkeeping      │                          │
   │                        │                          │                              │                          │
   │                        │  AsyncGenerator done     │                              │                          │
   │                        │◄─────────────────────────┤                              │                          │
   │  '> ' prompt           │                          │                              │                          │
   │◄───────────────────────┤                          │                              │                          │
```

**Engine bookkeeping** — same shape as the per-tool flow at the top of
this README; the only specialness is at ②, where the dispatch goes
in-process to `Agent.call()` instead of out to `Local`. The
`{ content }` it returns becomes the `tool_result` content, no injection.

**Final state of the parent's `messages[]`** — same 4-entry shape as any
one-shot tool call:

```
[0] UserMessage       content=[TextBlock("Use the explorer subagent to find ...")]
[1] AssistantMessage  content=[ToolUse(Agent, { description, prompt, subagent_type })]
[2] ToolMessage       content=[ToolResult(<child's last assistant text — full report>)]
[3] AssistantMessage  content=[TextBlock("The QueryEngine lives at src/QueryEngine.ts:47, ...")]
```

### Phase 3 — invocation, inside `Agent.call()`

`Agent.call()` spawns a fresh `QueryEngine` and drains it. The child runs
its own full sample/dispatch loop — same shape as the high-level
architectural flow at the top of this README, just with the agent body as
its system prompt and a filtered tool pool.

```
   Agent.call              Child QE                    Provider                    Local
       │                       │                            │                         │
       │ build child:          │                            │                         │
       │  ── filter parent     │                            │                         │
       │     tools (drop Agent,│                            │                         │
       │     apply allowlist)  │                            │                         │
       │  ── system prompt =   │                            │                         │
       │     agent body        │                            │                         │
       │                       │                            │                         │
       │ new QueryEngine ─────►│                            │                         │
       │                       │                            │                         │
       │ submitMessage(prompt) │                            │                         │
       ├──────────────────────►│                            │                         │
       │                       │  ╔══ child loop ═══════════════════════════════════╗ │
       │                       │  ║ sampleStream → Provider                         ║ │
       │                       │  ║ message_complete → if tool_use, dispatch &      ║ │
       │                       │  ║   loop; if stop, exit                           ║ │
       │                       │  ║ tool dispatch may hit Local (Bun.file, spawn)   ║ │
       │                       │  ╚═════════════════════════════════════════════════╝ │
       │◄── generator done ────┤                            │                         │
       │                       │                            │                         │
       │ extract last          │                            │                         │
       │ assistant text        │                            │                         │
       │ return { content }    │                            │                         │
```

The child's transcript is **discarded** when `Agent.call()` returns. Only
the final assistant text comes back, as the `content` of the parent's
`[2] ToolMessage` above. That is the whole point — the parent gets a clean
report without paying the token cost of the child's intermediate work.

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
