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

### `dispatch`

Spawns a wave and returns in under a second. Lanes run
`<timeoutBin> <deadlineSec> <piBin> --mode json --no-session -ns [flags] @<brief>`
detached, events streaming to `<workDir>/<wave>-<name>.events.jsonl`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `wave` | string | — | Wave slug: `kebab-case`, max 64 chars, must not exist in `workDir` |
| `lanes` | array | — | One entry per lane (min 1); lane slugs unique within the wave |
| `lanes[].name` | string | — | Lane slug: `kebab-case`, max 64 chars |
| `lanes[].briefPath` | string | — | Path to the lane's brief file (its `@file` prompt) |
| `lanes[].model` | string? | inherit | Pin a model id for this lane |
| `lanes[].deadlineSec` | number? | `deadlineSec` config (900) | Leash in seconds; holds even if the dispatcher is gone. Minimum 1 |
| `lanes[].tools` | string? | all tools | Tool allowlist for `--tools`, e.g. `"read,grep,find,ls,bash"` |
| `lanes[].noExtensions` | boolean? | false | Pass `-ne` (drop extensions incl. MCP in the lane) |
| `lanes[].mcp` | boolean? | true | Set `false` to pass `--no-mcp` |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory for manifest, events, and artifacts |

**Result:** text summary plus `structuredContent` — `{ wave, manifestPath, lanes[] }`
with each lane's pid, paths, and deadline. Spawned lanes stream events
immediately; a lane that failed to spawn appears as `SPAWN ERROR: …`.

**Errors** (the whole call fails, zero lanes spawned, no slug claimed):
a brief file missing (all missing paths listed) · malformed or duplicate slugs ·
wave slug already exists · `timeoutBin`/`piBin` not found on `PATH`.

### `lanes`

Stateless: every call reads the manifest fresh, so any session — including a
fresh one after the dispatcher exited — sees the same truth.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `wave` | string | — | Wave slug |
| `action` | string? | `"status"` | `"status"` \| `"kill"` \| `"collect"` |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory holding the manifest |

**`status`** — per-lane `structuredContent` entries:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | lane slug |
| `state` | string | `starting` \| `running` \| `settled` \| `failed` |
| `cause` | string? | for `failed`: `spawn` · `killed` · `deadline` · `crashed` |
| `overdue` | boolean? | alive past its deadline (leash misfire) — informational |
| `turns` | number | turn count so far |
| `usage` | object | run totals summed over assistant messages: `{input, output, cacheRead, cacheWrite, cost}` |
| `stopReason` | string? | last assistant stop reason (`stop` is clean) |
| `lastEventAgeSec` | number? | seconds since the events file last grew — the stuck-lane signal |
| `spawnError` | string? | why a `spawn`-failed lane never started |
| `errTail` | string? | last lines of `.err` for `crashed` lanes |

**`kill`** — SIGTERM to each eligible lane's process group (never a
start-time-mismatched/reused PID; settled lanes skipped), SIGKILL after the
`killGraceMs` config grace, then a manifest tombstone so the kill survives
re-adoption. Idempotent; honors tool-call cancellation during the grace wait.

**`collect`** — for each finished lane, writes the final assistant message
(text blocks concatenated) to `<wave>-<name>.md`. Entries carry
`{ name, artifact, suspect, stopReason }`; `suspect: true` when the lane
failed, the message is empty, or the stop reason was not clean. Refuses lanes
still running or never spawned.

## Configuration

All knobs are configurable — nothing is hardcoded. JSON files, later wins:

1. defaults (documented in the tables above)
2. `<agent-dir>/pi-minimal-dispatch.json` — user level (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`)
3. `.pi/pi-minimal-dispatch.json` — project level (working directory)
4. per-call tool parameters

| Key | Type | Default | Description |
|---|---|---|---|
| `workDir` | string | `.pi/work` | Default wave directory |
| `deadlineSec` | number | `900` | Default lane leash (integer ≥ 1) |
| `killGraceMs` | number | `5000` | SIGTERM→SIGKILL grace in the `kill` action (integer ≥ 100) |
| `pollMs` | number | `2000` | Statusbar poll interval (integer ≥ 100) |
| `piBin` | string | `"pi"` | Lane pi binary, resolved from `PATH` |
| `timeoutBin` | string | `"timeout"` | Leash binary — set `"gtimeout"` if coreutils isn't linked on macOS |

```json
{
	"deadlineSec": 600,
	"timeoutBin": "gtimeout"
}
```

Invalid files fail loudly at the next tool call: the error names the file and
the valid keys/values. Unknown keys are rejected.

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
