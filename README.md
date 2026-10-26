# pi-minimal-dispatch

Minimal detached lane dispatch with **visible state** for the
[pi coding agent](https://pi.dev) — two tools, one manifest, no framework.

Dispatch sub-agents from a pi session without blocking it. Lanes run as
detached `pi --mode json` processes in their own process groups, survive the
dispatcher's death, and report live state derived from their event streams —
never guessed from empty files.

```
wave 'survey':
  docs [glm-4.6 think:high] · running · 2 turns · tok 5703in/90out, $0.0009 · stop:toolUse · last 3.1s ago
  review [glm-5.3-flash] · settled · 4 turns · tok 12021in/310out, $0.0041 · stop:stop · last 12s ago
```

## Why

Other pi subagent extensions run children inside the dispatcher's process and
die with it — or need a server to keep them alive. **pi-minimal-dispatch lanes
are plain `pi --mode json` processes in their own process groups that outlive
the dispatcher, observable as plain files, collectible by any later session.**

- `dispatch` returns the moment lanes are spawned — the dispatcher keeps working
- **the deadline leash is GNU `timeout -k` around each process** — it fires even
  after the dispatcher has exited
- a later session re-adopts any wave from its manifest: `status`, `wait`, `kill`, `collect`
- the final text is a file on disk (`<wave>-<name>.md`), not a block pasted back
  into the parent's context

It replaces hand-written bash dispatch (`pi --print @brief > out.md &`), which
leaves the dispatcher blind while lanes run: the artifact stays empty until the
lane exits (working and hung look identical), killing means signaling a wrapper
PID of unclear ownership, a mangled spawn line dies silently, and truncation,
crash, and never-started are indistinguishable after the fact.

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
pi install npm:pi-minimal-dispatch                         # official (registry)
pi install git:github.com/zhtmike/pi-minimal-dispatch      # tracks main — between releases
pi -e ./src/index.ts                                       # try it for one invocation
```

## Try this first

Write one brief file per lane (the lane's whole prompt — its goal, scope, and
expected deliverable), then ask in plain language:

```text
Dispatch two lanes: docs summarizes the request-handling module, review audits src/auth.
Wait for them to settle and collect the artifacts.
```

pi decides when to call the tools. A real session looks like:

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

The ceremony is *write briefs → `dispatch` → `lanes wait` (or poll `status`) →
`collect` → clean up*. For a quick single task: dispatch one lane and let a
single `wait` call hold open until it settles — no sleep-then-poll guessing,
no waking late after a settle. `dispatch` itself never blocks; waiting is an
explicit, bounded `lanes` call (`waitSec`, default 300, max 3600) that returns
the status table as soon as a poll finds every lane `settled`/`failed`
(within one `pollMs`).

**Steering** is kill + redispatch: briefs are files, so refine the brief and run
a new wave (slugs are single-use). **Hang detection**: `lastEventAgeSec` is the
signal — no event growth for ~2× the lane's normal turn latency ⇒ `kill` and
redispatch.

## API

Two tools — full parameter, output, and configuration reference in
[docs/API.md](docs/API.md).

- **`dispatch`** `{wave, lanes[], workDir?}` — validate briefs and slugs, claim
  the wave slug atomically, spawn every lane detached in its own process
  group, return in under a second. Per-lane: `model`, `thinking`,
  `deadlineSec`, `tools`, `noExtensions`, `mcp`.
- **`lanes`** `{wave, action?, waitSec?, workDir?}` — stateless `status` /
  `wait` / `kill` / `collect` over the wave's manifest; any session can re-adopt
  a wave, including after the dispatcher exited.

**Web/MCP reach**: the default lane is offline. MCP servers connecting grants
nothing by themselves — a lane reaches their tools only through `codemode` or
`tool_search` named in its `tools` (`codemode` scripts and `tool_search` wait
for the servers they need; an `mcp__server__*` entry declares tools directly
only when the server has `direct` exposure in `mcp.json`, so it is a scope,
not a route). A lane that leaves MCP enabled without `codemode`/`tool_search`
in `tools` would run blind, so `dispatch` rejects it — pass a route or set
`mcp: false` (servers never connect). Entries reach pi verbatim, no shell
quoting: `tools: "read,grep,find,ls,codemode"`. Plain names/patterns only:
`+name`/`-name` modifier lists (which pi applies to its default selection,
silently granting `bash`/`edit`/`write`) and empty lists are rejected too.

## Configuration

The lane protocol is fixed (`--mode json --no-session -ns` — lanes never load
skills); every variable knob is configurable. Defaults come from the
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
workDir — and completes wave names. Each line tags the lane with its model —
short id (provider prefix dropped), thinking level appended as `think:<level>`
when set — the actual model from the event stream once answers exist, the pinned
value before that. Both are TUI conveniences over the same derived state the
`lanes` tool reports.

## State model

Each lane's status is derived on every call from its event stream, PID
liveness (guarded by process start-time — a reused PID is never signaled),
and the deadline. Never stored, never stale. `settled` means the
`agent_settled` event was seen — **success is `collect` with
`suspect: false`**; a death after the deadline is labeled `deadline` even
when the process crashed. The statusbar and `/lanes` are TUI/RPC-only —
`--print`/`--mode json` sessions see status through the `lanes` tool alone.

| State | Meaning |
|---|---|
| `starting` | spawned, no session header yet |
| `running` | events flowing (`overdue: true` once past deadline) |
| `settled` | `agent_settled` emitted (any stop reason — success is `collect` with `suspect: false`) |
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
node tests/derive.test.ts    # state derivation, wait loop, liveness guard, event parsing
node tests/format.test.ts    # presentation formatters
node tests/lane.test.ts      # slugs, briefs, argv, lane tool-contract validation
bash tests/prove.sh          # integration: replays a live wave (bills models)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent instructions live in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
