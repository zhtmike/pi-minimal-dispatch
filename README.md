# pi-minimal-dispatch

Minimal detached lane dispatch with **visible state** for the
[pi coding agent](https://pi.dev) — two tools, one manifest: no personas,
no queue, no server, zero runtime dependencies.

Lanes are detached `pi --mode json` processes in their own process groups:
they survive the dispatcher's death, and their live state is derived from
their event streams — never guessed from empty files.

```
wave 'survey':
  docs [glm-4.6 think:high] · running · 2 turns · tok 5703in/90out, $0.0009 · stop:toolUse · last 3.1s ago
  review [glm-5.3-flash] · settled · 4 turns · tok 12021in/310out, $0.0041 · stop:stop · last 12s ago
```

## Why

pi itself ships no sub-agents — the pi README: "skips features like
sub-agents and plan mode. Ask Pi to build what you want, or install a
package that does it your way." Most packages that answer grow an agent
cast: persona rosters and per-role system-prompt markdown (custom agent
types in `@tintinweb/pi-subagents`, builtin specialists in `pi-subagents`
and `pi-orchestrator-config`), concurrency pools and spawn budgets, fleet
UIs, hub servers or daemons that must stay alive. pi-minimal-dispatch
takes the other end of the trade:

- **No personas, no role play** — a lane is a brief file plus optional
  `model`/`thinking` pins: no agent roster, no per-role system prompts.
  The dispatching agent keeps the judgment — it writes each brief, so it
  decides what each lane is.
- **The filesystem is the whole protocol** — briefs in, per-lane JSONL
  event streams, one JSON manifest, `<wave>-<name>.md` artifacts out. No
  hub, no broker, no in-memory runtime state: any process, including a
  session that never dispatched, can read, re-adopt, or collect a wave
  from plain files.
- **The caller decides how many lanes** — no queue, no pool, no cap in
  the tool: every lane in a `dispatch` call is spawned at once. OS and
  provider rate limits still apply; pacing is the caller's discipline,
  not the tool's.
- **Zero runtime dependencies** — Node builtins plus a small documented
  host-API surface, plain TypeScript with no build step; CI typechecks
  against both the pi 1.4.0 floor and latest pi. The lane protocol rides
  pi's CLI flags and JSON event stream, which have changed within 1.x
  before — compatibility beyond the tested floor is best-effort, not a
  promise.

Landscape data and the full design rationale: [docs/design.md](docs/design.md).

In practice, lanes outlive the dispatcher: `dispatch` returns the moment
they spawn, the deadline leash (GNU `timeout -k`) fires even after the
dispatcher has exited, any later session re-adopts the wave from its
manifest (`status` / `wait` / `kill` / `collect`), and the final text
lands on disk (`<wave>-<name>.md`) instead of being pasted back into the
parent's context. It replaces hand-written bash dispatch
(`pi --print @brief > out.md &`), which leaves the dispatcher blind: the
artifact stays empty until exit (working and hung look identical), a
mangled spawn line dies silently, and killing means signaling a PID of
unclear ownership.

## Requirements

- pi ≥ 1.4.0, **macOS or Linux** (POSIX process groups, `ps -o lstart=`,
  `timeout` — Windows is not supported)
- GNU `timeout`: preinstalled on Linux; on macOS `brew install coreutils`
  or set `timeoutBin: "gtimeout"` ([Configuration](#configuration))

## Install

```bash
pi install npm:pi-minimal-dispatch                     # official (registry)
pi install git:github.com/zhtmike/pi-minimal-dispatch  # tracks main
pi -e ./src/index.ts                                   # try it for one invocation
```

## Quick start

Write one brief file per lane — the lane's whole prompt: goal, scope,
expected deliverable. Then ask in plain language:

```text
Dispatch two lanes: docs summarizes the request-handling module, review audits src/auth.
Wait for them to settle and collect the artifacts.
```

A real session:

```text
> dispatch  wave="survey" lanes=[{name:"docs", briefPath:".pi/work/survey-docs-brief.md",
            model:"zai/glm-5.3-flash", mcp:false},
            {name:"review", briefPath:".pi/work/survey-review-brief.md", mcp:false}]
  wave 'survey' dispatched — 2/2 lanes spawned
    docs: pid 99015 (deadline 900s)
    review: pid 99016 (deadline 900s)
  manifest: /abs/path/to/.pi/work/survey-manifest.json

> lanes     wave="survey" action="wait"
  docs [glm-5.3-flash] · settled · 2 turns · tok 5703in/90out, $0.0009 · stop:stop · last 0.8s ago
  review [glm-4.6] · settled · 4 turns · tok 12021in/310out, $0.0041 · stop:stop · last 2.1s ago

> lanes     wave="survey" action="collect"
  collect wave 'survey':
    docs: /abs/path/to/.pi/work/survey-docs.md stop:stop
    review: /abs/path/to/.pi/work/survey-review.md stop:stop
```

The ceremony: *write briefs → `dispatch` → `wait` (or poll `status`) →
`collect` → clean up*. `dispatch` never blocks; waiting is an explicit,
bounded `wait` call that returns the status table the moment every lane
is `settled`/`failed` — no sleep-then-poll guessing. **Steering** is
kill + redispatch: refine the brief, run a new wave (slugs are
single-use). **Hang detection**: `lastEventAgeSec` is the signal — no
event growth for ~2× the lane's normal turn latency ⇒ `kill` and
redispatch.

## API

Two tools — full parameter, output, and configuration reference in
[docs/api.md](docs/api.md).

- **`dispatch`** `{wave, lanes[], workDir?}` — validate briefs and slugs,
  claim the wave slug atomically, spawn every lane detached in its own
  process group, return in under a second. Per-lane: `model`, `thinking`,
  `deadlineSec`, `tools`, `noExtensions`, `mcp`.
- **`lanes`** `{wave, action?, waitSec?, workDir?}` — stateless `status` /
  `wait` / `kill` / `collect` over the wave's manifest; any session can
  re-adopt a wave, including after the dispatcher exited.

**Web/MCP reach**: the default lane is offline. MCP servers connecting
grants nothing by themselves — a lane reaches their tools only through
`codemode` or `tool_search` named in its `tools`, and `dispatch` rejects
a lane that leaves MCP enabled without a route. Rules and examples:
[MCP and web reach](docs/api.md#mcp-and-web-reach).

## Configuration

The lane protocol is fixed (`--mode json --no-session -ns` — lanes never
load skills); every variable knob is configurable — `workDir`,
`deadlineSec` (900), `killGraceMs` (5000), `pollMs` (2000), `piBin`,
`timeoutBin` — merged defaults → user file → project file → per-call
parameters. Invalid files fail loudly. Full table and precedence rules:
[docs/api.md](docs/api.md#configuration).

## Status bar & `/lanes`

While any tracked lane runs, the footer shows one line (e.g.
`lanes: 2 running · 1 settled`), cleared when nothing is in flight.
`/lanes [<wave>]` prints the full status table for waves seen this
session (an untracked wave name is resolved from the default workDir)
and completes wave names. Each line tags the lane with its model —
short id (provider prefix dropped), `think:<level>` appended when set —
the actual model from the event stream once generation begins, the
pinned value before that, `[default]` for a no-pin lane that hasn't
started. Both are TUI conveniences over the same derived state the
`lanes` tool reports; `--print`/`--mode json` sessions see status
through the tool alone.

## State model

Derived on every call from the event stream, PID liveness (guarded by
process start-time — a reused PID is never signaled), and the deadline.
Never stored, never stale. `settled` means the `agent_settled` event was
seen — **success is `collect` with `suspect: false`**.

| State | Meaning |
|---|---|
| `starting` | spawned, no session header yet |
| `running` | events flowing (`overdue: true` once past deadline) |
| `settled` | `agent_settled` emitted (any stop reason — success is `collect` with `suspect: false`) |
| `failed` | cause: `spawn` (synchronous, nothing ran) · `killed` (tombstoned) · `deadline` (leash fired, even parentless; a crash after the deadline is still `deadline`) · `crashed` (`.err` tail attached) |

How lanes are spawned, what the manifest records, and why state is never
stored: [Mechanics in docs/design.md](docs/design.md#mechanics).

## Testing

`npm test` runs the unit suites (config, derive, format, lane);
`bash tests/prove.sh` replays a live wave and bills models.

## Contributing · License

[CONTRIBUTING.md](CONTRIBUTING.md) · agent instructions in
[AGENTS.md](AGENTS.md) · [MIT](LICENSE)
