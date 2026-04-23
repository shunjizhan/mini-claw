---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

## **VERY IMPORTANT — Real Claude Code references**

Whenever the user asks you to reference, cite, look up, verify, or compare
against anything from "real Claude Code" / "real CC" / Anthropic's Claude
Code CLI:

- **ALWAYS read from `../claude-code/`** — a sibling directory holding a
  checkout of real Claude Code's source. Treat it as the ground truth for
  behavior, file layout, and `file:line` citations. Files mini-claw already
  cites (e.g. `src/skills/loadSkillsDir.ts`, `src/tools/SkillTool/SkillTool.ts`)
  are present there and should be re-read, not recalled from memory.
- **DO NOT** guess, paraphrase, or recite real CC behavior from
  training-data memory. Real CC evolves faster than any model cutoff;
  recall is unreliable and the existing mini-claw comments depend on
  accurate references.
- **If you cannot access `../claude-code/`** (path missing, permission
  denied, file not where expected, sandbox restriction), **STOP and tell
  the user immediately** rather than fabricating references or falling
  back to memory. Say so explicitly so they can fix the access.

This applies both when the user mentions real CC by name AND when extending
or verifying any of mini-claw's existing real-CC citations.

## **VERY IMPORTANT — Mini-claw mirrors real CC; we NEVER invent our own design**

The whole point of mini-claw is to study real Claude Code's design and
flow. It is a teaching/reference port, not an opinion port. The rule:

- **Every architectural decision must trace back to a specific file:line in
  `../claude-code/`.** If real CC does X, mini-claw does X (subset, not a
  reimagining). When in doubt, read the source.
- **DO NOT invent fields, mechanisms, frontmatter shapes, tool patterns,
  registration flows, or any other architectural element that real CC
  doesn't already have.** "I think this would be cleaner / more typed /
  more ergonomic" is NOT sufficient justification. Mini-claw's job is to
  reflect real CC's choices, not improve them.
- **If real CC doesn't support a capability the user asks for, say so
  explicitly with citations** — don't paper over with a mini-claw-specific
  solution and pretend it matches. The user wants the real flow; tell them
  the real answer.
- **Simplifications are allowed; inventions are not.** Mini-claw is
  intentionally a Tier-3 subset of real CC (no plugins, no MCP, no
  subagents, etc.). Skipping features is fine and expected. Replacing them
  with a different design is not.
- **If you've already started building something that diverges from real
  CC, stop and surface it.** Past mistake: "per-skill typed tools via
  `tools:` frontmatter" — invented from scratch, not in real CC. The
  correct response was to revert and acknowledge real CC's actual pattern
  (single `SkillTool` dispatcher + body delivered via `newMessages` +
  optional `allowed-tools` permission shortcut). Use that as a precedent.

The litmus test before adding any architectural code or comment: "Can I
point to a specific file:line in `../claude-code/` that does this?" If no,
stop, ask, or revert.

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
