# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

`pi-minimal-dispatch` is a [pi](https://pi.dev) extension (pi ≥ 1.4.0) with a
deliberately small surface: two tools (`dispatch`, `lanes`), one manifest
format, one derivation core. Read [README.md](README.md) first — it is the
user-facing contract. When code and README disagree, that is a bug in one of
them; fix the disagreement, not just the code.

## Layout

- `src/index.ts` — tool definitions, detached spawning, kill/collect actions
- `src/derive.ts` — manifest + event-stream parsing + state derivation; pure
  Node builtins, importable without the pi host (unit tests rely on this)
- `tests/derive.test.ts` — plain `node` script, no framework
- `tests/prove.sh` — live integration replay (bills models; `PI_BIN` override)

## Working rules

- Keep the surface minimal: a new option, state, or action must justify itself
  against the README's contract or be cut. No queueing, no steering, no UI —
  those are non-goals by design.
- Fail fast, never silently fall back: validation happens at the tool boundary
  (slugs, brief paths, deadlines); a lane's failure becomes a visible state,
  not a swallowed error.
- Detached spawns must stay detached: lanes outlive the dispatcher, deadlines
  hold parentless via the `timeout` wrapper, and a reused PID is never
  signaled (start-time guard in `pidAlive`).
- Tabs for indentation; WHY-comments only, two lines max; no PR/issue
  citations in comments.
- Every behavior change ships with a unit test in the same change; run
  `node tests/derive.test.ts` before declaring done.

## Testing

```bash
node tests/derive.test.ts    # must pass; cheap CPU, no model calls
bash tests/prove.sh          # live wave; requires pi >= 1.4.0 and GNU timeout
```

The pi host API surface used here (`defineTool`, `Type`, `StringEnum`,
`ExtensionAPI`, `registerTool`) is verified against the installed pi package —
check a current pi checkout before changing imports.
