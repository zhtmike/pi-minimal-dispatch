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

Other pi subagent extensions run children inside the dispatcher's process and
die with it — or need a server to keep them alive. **pi-minimal-dispatch lanes
are plain `pi --mode json` processes in their own process groups that outlive
the dispatcher, observable as plain files, collectible by any later session.**

- `dispatch` returns the moment lanes are spawned — the dispatcher keeps working
- **the deadline leash is GNU `timeout -k` around each process** — it fires even
  after the dispatcher has exited
- a later session re-adopts any wave from its manifest: `status`, `kill`, `collect`
- the final text is a file on disk (`<wave>-<name>.md`), not a block pasted back
  into the parent's context

It replaces hand-written bash dispatch (`pi --print @brief > out.md &`), which
leaves the dispatcher blind while lanes run: the artifact stays empty until the
lane exits (working and hung look identical), killing means signaling a wrapper
PID of unclear ownership, a mangled spawn line dies silently, and truncation,
crash, and never-started are indistinguishable after the fact.

## Requirements

- pi ≥ 1.3.0 — 1.4.0 recommended (it fixes pi deactivating extension tools after
  `/resume` and `/tree` navigation, which wave re-adoption relies on)
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
Poll them and collect the artifacts when they settle.
```

pi decides when to call the tools. A real session looks like:

```text
> dispatch  wave="survey" lanes=[{name:"docs", briefPath:".pi/work/survey-docs-brief.md",
            model:"zai/glm-5.3-flash", deadlineSec:600}]
  wave 'survey' dispatched — 1/1 lanes spawned
    docs: pid 99015 (deadline 600s)
  manifest: /abs/path/to/.pi/work/survey-manifest.json

> lanes     wave="survey"
  docs · running · 1 turns · tok 2966in/84out, $0.0005 · stop:toolUse · last 3s ago

> lanes     wave="survey" action="collect"
  collect wave 'survey':
    docs: /abs/path/to/.pi/work/survey-docs.md stop:stop
```

The ceremony is *write briefs → `dispatch` → poll `lanes status` → `collect` →
clean up*. For a quick single task: dispatch one lane, poll once after the
expected duration, collect — there is deliberately no blocking mode.

**Steering** is kill + redispatch: briefs are files, so refine the brief and run
a new wave (slugs are single-use). **Hang detection**: `lastEventAgeSec` is the
signal — no event growth for ~2× the lane's normal turn latency ⇒ `kill` and
redispatch.

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
workDir — and completes wave names. Both are TUI conveniences over the same
derived state the `lanes` tool reports.

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
node tests/derive.test.ts    # state derivation, liveness guard, event parsing
node tests/format.test.ts    # presentation formatters
bash tests/prove.sh          # integration: replays a live wave (bills models)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Agent instructions live in
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
