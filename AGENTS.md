# AGENTS.md

Guidance for AI agents working in this repository.

## What this is

`pi-minimal-dispatch` is a [pi](https://pi.dev) extension (pi ≥ 1.4.0) with a
deliberately small surface: two tools (`dispatch`, `lanes`), one manifest
format, one derivation core. Read [README.md](README.md) first, then
[docs/api.md](docs/api.md) — together they are the user-facing contract.
When code and docs disagree, that is a bug in one of
them; fix the disagreement, not just the code. The tool schemas in
`src/index.ts` are the model-facing half of the same contract — keep the
three in sync in the same change.

## Layout

- `src/index.ts` — tool definitions, detached spawning, wait/kill/collect actions, statusbar + `/lanes`
- `src/config.ts` — configuration: defaults, user/project file merge, validation
- `src/events.ts` — typed lane event-stream parsing (`pi --mode json` JSONL)
- `src/derive.ts` — manifest registry, process liveness, state derivation; pure Node builtins, importable without the pi host
- `src/format.ts` — presentation formatters shared by tool, command, and statusbar
- `docs/` — `api.md` (tool reference), `design.md` (positioning, mechanics, non-goals)
- `tests/*.test.ts` — plain `node` scripts, no framework; `tests/prove.sh` — live integration replay (`PI_BIN` override)

## Working rules

- Keep the surface minimal: a new option, state, or action must justify itself
  against the README's contract or be cut. No queueing, no steering, no fleet
  UI — those are non-goals by design (the statusbar line and `/lanes`
  command are the deliberate extent of the UI).
- Fail fast, never silently fall back: validation happens at the tool boundary
  (slugs, brief paths, deadlines); a lane's failure becomes a visible state,
  not a swallowed error.
- Detached spawns must stay detached: lanes outlive the dispatcher, deadlines
  hold parentless via the `timeout` wrapper, and a reused PID is never
  signaled (start-time guard in `pidAlive`).
- Tabs for indentation; WHY-comments only, two lines max; no PR/issue
  citations in comments.
- Every behavior change ships with a unit test in the same change; run all
  `tests/*.test.ts` before declaring done.

## Testing

```bash
node tests/config.test.ts     # must pass; cheap CPU, no model calls
node tests/derive.test.ts     # must pass
node tests/format.test.ts     # must pass
bash tests/prove.sh           # live wave; requires pi >= 1.4.0 and GNU timeout
```

The pi host API surface used here (`defineTool`, `Type`, `StringEnum`,
`ExtensionAPI`, `registerTool`) is verified against the installed pi package —
check a current pi checkout before changing imports.
