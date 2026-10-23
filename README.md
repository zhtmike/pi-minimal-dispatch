# pi-minimal-dispatch

Minimal detached lane dispatch with **visible state** for the
[pi coding agent](https://pi.dev) — two tools, one manifest, no framework.

Dispatch sub-agents from a pi session without blocking it. Lanes run as
detached `pi --mode json` processes in their own process groups, survive the
dispatcher's death, and report live state derived from their event streams —
never guessed from empty files.

```
wave 'survey':
  docs   · running · 2 turns · tok 5703in/90out, $0.0009 · stop:toolUse · last 3.1s ago
  review · settled · 4 turns · tok 12021in/310out, $0.0041 · stop:stop · last 12s ago
```

## Why

Hand-written bash dispatch (`pi --print @brief > out.md &`) leaves the
dispatcher blind while lanes run:

- the artifact stays empty until the lane exits — *working* and *hung* look identical
- killing a lane means signaling a wrapper PID of unclear ownership
- a mangled spawn line dies silently; a timeout kill loses everything
- truncation, crash, and never-started are indistinguishable after the fact

`pi-minimal-dispatch` fixes the seam itself: the extension owns the spawn, the
lane emits a structured event stream, and state is *derived* from evidence.

## Requirements

- pi ≥ 1.4.0
- **macOS or Linux** — Windows is not supported (the extension relies on POSIX
  process groups, `ps`, and `timeout`)
- GNU `timeout`: preinstalled on Linux; on macOS install it with
  `brew install coreutils` (or configure `timeoutBin: "gtimeout"` — see
  [Configuration](#configuration))
- `ps` with `-o lstart=` (procps on Linux, built-in on macOS): standard on both
- Lanes resolve the pi binary from the dispatcher's `PATH` (configurable)

## Install

```bash
pi install git:github.com/zhtmike/pi-minimal-dispatch   # or npm:pi-minimal-dispatch
pi -e ./src/index.ts                                    # try it for one invocation
```

## Try this first

Write one brief file per lane (the lane's whole prompt — its goal, scope, and
expected deliverable), then ask in plain language:

```text
Dispatch two lanes: docs summarizes the request-handling module, review audits src/auth.
Poll them and collect the artifacts when they settle.
```

pi decides when to call the tools. The ceremony is:
*write briefs → `dispatch` → poll `lanes status` → `collect` → clean up*.

## API

Two tools — full parameter, output, and configuration reference in
[docs/API.md](docs/API.md).

- **`dispatch`** `{wave, lanes[], workDir?}` — validate briefs and slugs, claim
  the wave slug atomically, spawn every lane detached in its own process
  group, return in under a second. Per-lane: `model`, `deadlineSec`, `tools`,
  `noExtensions`, `mcp`.
- **`lanes`** `{wave, action?, workDir?}` — stateless `status` / `kill` /
  `collect` over the wave's manifest; any session can re-adopt a wave,
  including after the dispatcher exited.

## Configuration

All knobs are configurable — nothing is hardcoded. Defaults come from the
extension; user config `~/.pi/agent/pi-minimal-dispatch.json` and project
config `.pi/pi-minimal-dispatch.json` override them, and per-call parameters
win last: `workDir`, `deadlineSec` (900), `killGraceMs` (5000), `pollMs`
(2000), `piBin`, `timeoutBin` (set `"gtimeout"` when coreutils isn't linked
on macOS). Invalid files fail loudly at the next tool call. Full table and
precedence rules: [docs/API.md](docs/API.md#configuration).

## Status bar & `/lanes`

While any tracked lane runs, the footer shows one line — e.g. `lanes: 2 running · 1 settled`
— updated at the `pollMs` cadence and cleared when nothing is in flight.
`/lanes` (optionally `/lanes <wave>`) prints the full status table for waves
seen this session — an untracked wave name is resolved from the default
workDir — and completes wave names. Both are TUI conveniences over the same
derived state the `lanes` tool reports.

## State model

Each lane's status is derived on every call from its event stream, PID
liveness (guarded by process start-time — a reused PID is never signaled),
and the deadline. Never stored, never stale:

| State | Meaning |
|---|---|
| `starting` | spawned, no session header yet |
| `running` | events flowing (`overdue: true` once past deadline) |
| `settled` | `agent_settled` emitted — final message available |
| `failed` | cause: `spawn` (synchronous, nothing ran) · `killed` (tombstoned) · `deadline` (leash fired, even parentless) · `crashed` (`.err` tail attached) |

## How it works

- **Lane**: detached via an argv array (no `sh -c` wrapper to mangle) in its
  own process group; the `timeout` wrapper is the deadline leash.
- **Registry**: `<workDir>/<wave>-manifest.json`, created atomically (`wx` —
  slug collisions and concurrent same-wave dispatches fail loudly). Plain
  JSON on disk: pids, process start-times, deadlines, brief paths — everything
  a later session needs to re-adopt the wave. The extension never deletes
  wave artifacts; cleanup stays an explicit step.
- **State**: derived on every call — never stored, never stale.

## Testing

```bash
node tests/config.test.ts    # configuration precedence + validation
node tests/derive.test.ts    # state derivation, liveness guard, event parsing
node tests/format.test.ts    # presentation formatters
bash tests/prove.sh          # integration: replays a live wave (bills models)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent instructions live in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
