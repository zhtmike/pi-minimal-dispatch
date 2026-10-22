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
  `brew install coreutils` (the `timeout` binary must be on `PATH`)
- `ps` with `-o lstart=` (procps on Linux, built-in on macOS): standard on both
- Lanes resolve `pi` from the dispatcher's `PATH`

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

## The tools

### `dispatch`

```json
{
  "wave": "survey",
  "lanes": [
    { "name": "docs",   "briefPath": ".pi/work/survey-docs-brief.md",
      "model": "zai/glm-5.3-flash", "deadlineSec": 600 },
    { "name": "review", "briefPath": ".pi/work/survey-review-brief.md",
      "deadlineSec": 900, "tools": "read,grep,find,ls,bash", "noExtensions": true }
  ],
  "workDir": ".pi/work"
}
```

- Validates every brief and every slug **before** spawning: a typo'd brief or
  malformed slug fails synchronously with zero lanes spawned.
- Claims the wave slug atomically — reusing a wave name, or two concurrent
  dispatches of the same wave, fail loudly instead of clobbering.
- Spawns each lane detached in its own process group and returns in under a
  second. The dispatcher stays free; lanes survive its exit.
- Per-lane options: `model`, `deadlineSec` (default 900), `tools` (allowlist),
  `noExtensions` (pass `-ne`), `mcp: false` (pass `--no-mcp`).

### `lanes`

Stateless: every call reads the manifest fresh, so any session — including a
fresh one after the dispatcher exited — sees the same truth.

- **`status`** (default) — per lane: derived state, turns, run-total token
  usage and cost, `stopReason`, last-event age, `.err` tail for crashed lanes.
- **`kill`** — SIGTERM the lane's process group, SIGKILL after a 5 s grace;
  start-time guarded so a reused PID is never signaled; records a tombstone.
- **`collect`** — write each finished lane's final assistant message to
  `<wave>-<name>.md`, suspect-flagged when the lane failed, its final message
  is empty, or the stop reason was not clean. Refuses lanes still running or
  never spawned.

## How it works

- **Lane**: `timeout <deadlineSec> pi --mode json --no-session -ns [flags] @<brief>`,
  spawned detached via an argv array (no `sh -c` wrapper to mangle); events
  stream to `<workDir>/<wave>-<name>.events.jsonl`. The `timeout` wrapper is
  the deadline leash — it holds even if the dispatcher is gone.
- **Registry**: `<workDir>/<wave>-manifest.json`, created atomically (`wx`).
  Plain JSON on disk: pids, process start-times, deadlines, brief paths —
  everything a later session needs to re-adopt the wave. The extension never
  deletes anything; cleanup stays an explicit step.
- **State**: derived on every call from the event stream, PID liveness
  (guarded by process start-time), and the deadline. Never stored, never
  stale.

| State | Meaning |
|---|---|
| `starting` | spawned, no session header yet |
| `running` | events flowing (`overdue: true` once past deadline) |
| `settled` | `agent_settled` emitted — final message available |
| `failed` | cause: `spawn` (synchronous, nothing ran) · `killed` (tombstoned) · `deadline` (leash fired, even parentless) · `crashed` (`.err` tail attached) |

## Testing

```bash
node tests/derive.test.ts   # unit: derivation rules (cheap CPU, no model calls)
bash tests/prove.sh         # integration: replays a live wave (bills models)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent instructions live in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
