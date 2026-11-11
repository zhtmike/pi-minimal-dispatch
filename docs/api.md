# API reference

Full reference for the two tools, their structured outputs, and configuration.
The lean overview lives in the [README](../README.md); the model-facing
descriptions live in the tool schemas in [`src/index.ts`](../src/index.ts) —
this document is the human-facing copy and must stay in sync with both.

## `dispatch`

Spawns a wave and returns in under a second. Lanes run
`<timeoutBin> -k <graceSec> <deadlineSec> <piBin> --mode json --no-session -ns [flags] @<brief>`
detached — the `--mode json --no-session -ns` triple is the fixed lane
protocol (fresh process, JSON event stream, skills never loaded); `-k`
escalates a caught SIGTERM to SIGKILL so a stalled dispose cannot outlive
the leash. Events stream to `<workDir>/<wave>-<name>.events.jsonl`.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `wave` | string | — | Wave slug: `kebab-case`, max 64 chars, must not exist in `workDir` |
| `lanes` | array | — | One entry per lane (min 1); lane slugs unique within the wave |
| `lanes[].name` | string | — | Lane slug: `kebab-case`, max 64 chars |
| `lanes[].briefPath` | string | — | Path to the lane's brief file (its `@file` prompt) |
| `lanes[].model` | string? | pi default | Pin a model id; omitted: pi's **configured default model** — not the dispatcher session's active model. Accepts pi's `id:thinking` suffix (e.g. `zai/glm-4.6:high`) |
| `lanes[].thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max`? | none | Pin a thinking level (pi's `--thinking`); wins over any `:level` suffix in `model`. pi clamps the level to the model's capabilities — status reports the actual level |
| `lanes[].deadlineSec` | number? | `deadlineSec` config (900) | Leash in seconds; holds even if the dispatcher is gone. Minimum 1 |
| `lanes[].tools` | string? | `read,grep,find,ls` | Tool allowlist for `--tools` — plain names or `*` patterns; no `+name`/`-name` modifiers, no shell quoting, not empty. Add `bash` when a lane must run commands (bash can still invoke git — and can write anywhere the dispatcher can: don't grant it to read-only lanes in a shared checkout; give write-capable lanes a scratch dir outside the repo). With MCP enabled, reach requires `codemode` or `tool_search` here — see [MCP and web reach](#mcp-and-web-reach) |
| `lanes[].noExtensions` | boolean? | false | Pass `-ne` (drop extensions incl. MCP in the lane) |
| `lanes[].mcp` | boolean? | enabled | Set `false` to pass `--no-mcp` (no MCP servers connect). With MCP enabled, `tools` must name `codemode` or `tool_search` or the call is rejected — servers connecting alone never declares MCP tools to the lane |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory for manifest, events, and artifacts |

**Result:** text summary plus `structuredContent` — `{ wave, manifestPath, lanes[] }`
with each lane's pid, paths, and deadline. The text ends with a one-line
`[next: lanes(wave=…, action='wait') …]` hint — the blocking call that replaces
status polling. The manifest also records the
dispatcher's `owner` — `{ sid, pid, host, lstart }` — which the `kill` and
`release` actions use as their ownership guard. Spawned lanes stream events
immediately; a lane that failed to spawn appears as `SPAWN ERROR: …`.

**Errors** (the whole call fails, zero lanes spawned, no slug claimed):
a brief file missing (all missing paths listed as resolved absolute paths —
a brief written in the same parallel tool-call batch as this dispatch can
still be in flight; re-run the same dispatch after the write returns) ·
malformed or duplicate slugs ·
`tools` that is not a plain allowlist (`+name`/`-name` modifiers, shell quoting,
or an empty list) · a lane leaving MCP enabled while its `tools` names neither
`codemode` nor `tool_search` · a brief carrying a fenced `bash`/`sh`/`shell`/`zsh`
block while its lane's `tools` grants no `bash` (grant `bash` or unfence — quoted
output belongs in a `text` fence) · wave slug already exists · `timeoutBin`/`piBin`
not found on `PATH`.

### MCP and web reach

`mcp` only controls whether servers connect; it never grants reach. A plain
`--tools` allowlist replaces the whole selection, and pi declares a server's
tools to the lane only through the routes below — anything else leaves
connected servers as unreachable dead weight, so `dispatch` rejects a lane
that leaves MCP enabled without one:

- `codemode` — scripts reach every non-hidden server's tools and wait for the
  servers they name: `tools: "read,grep,find,ls,codemode"`
- `tool_search` — loads non-direct MCP tools on demand, waiting for all
  servers when it runs

An `mcp__server__*` entry is a *scope*, not a route: it keeps only that
server's tools registered (for `codemode`/`tool_search` to use) and declares
them directly **only when the server or tool has `direct` exposure** in
`mcp.json` (`"exposure": "direct"` / `toolExposure`) — dispatch cannot know
the lane's server exposures, so `mcp__` entries alone never satisfy the rule.
For direct-exposure servers: `tools: "read,grep,find,ls,codemode,mcp__server__*"`
declares the tools and keeps them callable from scripts. The MCP resource
tools (`list_mcp_resources`, `list_mcp_resource_templates`,
`read_mcp_resource`) are exposure-gated the same way and do not count either.

Lanes that need no MCP set `mcp: false`. Entries reach pi verbatim (the
allowlist is one argv value — no shell quoting), and `+name`/`-name` modifier
lists are rejected because pi applies them to its default selection, silently
granting `bash`/`edit`/`write`.

**Recursion guard:** lanes run with `PI_MINIMAL_DISPATCH_CHILD=1` in their
environment, and the extension's factory stays out of any process carrying that
marker — a lane never gets the `dispatch` tool. `-ne` (`noExtensions`) remains
the switch that drops all extensions and MCP in a lane. Every lane in a call is
spawned; the caller bounds the wave.

## `lanes`

Stateless: every call reads the manifest fresh, so any session — including a
fresh one after the dispatcher exited — sees the same truth.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `wave` | string | — | Wave slug |
| `action` | string? | `"status"` | `"status"` \| `"wait"` \| `"kill"` \| `"collect"` \| `"release"` |
| `lane` | string[]? | — | `kill`/`collect` only: target exactly the named lanes. Unknown slug → error listing the wave's lanes; a bare string is wrapped (min 1 name) |
| `waitMode` | `"all"\|"hold"\|"any"`? | `"all"` | `wait` only: `hold` blocks until every lane is terminal (sits out already-known failures while siblings finish); `any` returns at the first terminal lane — the returned status table is unchanged |
| `waitSec` | number? | `300` | `wait` only: max seconds to hold the call open (1–3600) |
| `inlineMaxBytes` | integer? | `0` | `collect` only: inline each non-suspect lane's artifact content after its line when the artifact is ≤ N bytes (0 = never inline) |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory holding the manifest |

A parameter its action does not accept (`lane`, `waitMode`, `inlineMaxBytes`)
is rejected with an error naming the actions that take it — never silently
ignored. (`waitSec` outside `wait` keeps its legacy silent-ignore: a
compatibility carve-out, not the pattern.) An unknown `wave` errors with the
expected manifest path and a pointer to list live waves
(`ls <workDir>/*-manifest.json`).

### `status`

Per-lane `structuredContent` entries. Note: `settled` only means the
`agent_settled` event was seen — success is `collect` returning
`suspect: false`.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | lane slug |
| `state` | string | `starting` \| `running` \| `settled` \| `failed` |
| `cause` | string? | for `failed`: `spawn` · `killed` · `deadline` · `crashed` (a death after the deadline is `deadline` even when the process crashed) |
| `overdue` | boolean? | alive past its deadline (leash misfire) — informational |
| `turns` | number | turn count so far |
| `usage` | object | run totals summed over assistant messages: `{input, output, cacheRead, cacheWrite, cost}` |
| `model` | string? | model answering the last assistant message; earlier, the model from the lane's assistant `message_start` (pi sets it when generation begins); before that, the pinned model with pi's `:thinking` suffix split off (last colon, valid level word only). `undefined` only pre-generation on a lane that pins no model |
| `thinkingLevel` | string? | thinking level of the last assistant message (`off`–`max`); until the first message_end, the pinned level — explicit `thinking` over the model's `:level` suffix (`message_start` carries no level, so a pinned one stays) |
| `stopReason` | string? | last assistant stop reason (`stop` is clean) |
| `lastEventAgeSec` | number? | seconds since the events file last grew — the stuck-lane signal |
| `inflightTool` | string? | the lane's current tool — the latest `tool_execution_start` with no matching `_end` (`_start` carries no timestamp, so no tool age is derivable) |
| `spawnError` | string? | why a `spawn`-failed lane never started |
| `errTail` | string? | last ≤5 `.err` lines for `crashed` lanes, each width-capped — a corrupt transcript names its parse error here and the lane derives `failed`/`crashed` (fail-soft per lane: kill, collect, and release stay available for the wave) |

### `wait`

Holds the tool call open, re-reading the manifest and re-deriving state every
`pollMs`, until every lane is `settled`, any lane has failed, `waitSec`
(default 300, max 3600) elapses, or the call is cancelled — then returns
exactly the `status` payload. A failure wakes the call at the poll cadence:
a crashed lane is never sat on behind running siblings — the caller sees the
table and decides (sit the siblings out with `waitMode: "hold"`, `kill` the
rest, redispatch a fixed lane).
A timeout is **not** an error: lanes still
running show as `running`, and the caller waits again (or proceeds to
`kill`/`collect`, which refuse running lanes as usual). This replaces
sleep-then-status polling, which guesses the duration and wakes late after a
settle. `dispatch` still returns in under a second — blocking is always this
explicit, bounded observation call, and the deadline leash needs no observer.

`waitMode` selects the wake condition; the returned payload is always the
same full status table, and with every lane already terminal all modes
return immediately.

- `all` (default) — every lane `settled`, or any lane `failed`: a failure is
  surfaced at the poll cadence, never sat on behind running siblings.
- `hold` — every lane terminal (`settled` or `failed`): the blocking call for
  a wave that has already lost a lane — it sits out the known failure while
  the siblings finish, within `waitSec`.
- `any` — the first terminal lane: the scout fan-out's early-action need;
  three answers need not wait for the fourth.

A `lane` filter is not offered on `wait`: first-settlement plus a bounded
`waitSec` covers the early-action need.

### `kill`

SIGTERM to each eligible lane's process group (never a
start-time-mismatched/reused PID; settled lanes skipped). The grace to
SIGKILL watches the whole process group, not the `timeout` leader: the leader
may die on the SIGTERM while a TERM-immune member lingers, and only a
group-empty check ends the grace early. Then a manifest tombstone so the kill
survives re-adoption. Idempotent; a cancelled call escalates at once —
cancellation stops the waiting, never the kill.
Waves owned by a **live foreign session** are refused (see `release` for the
owner rules); killing your own wave or a provably-dead owner's runaway leash
is unaffected.

A `lane: [names]` filter scopes the signal: the target set is kill eligibility
∩ the filter — untargeted lanes receive no signal and no tombstone, their
records and files untouched, the manifest staying consistent for later
`status`/`collect`/`release`. The grace-escalation loop watches only the
current target set: an untargeted lane tombstoned by an *earlier* kill is
never re-signaled or awaited here (a tombstoned lane named in the filter is
still eligible — kill excludes settled lanes, not tombstoned ones — and
asking again re-signals it). Naming only ineligible lanes (settled or dead)
is not an error: the action reports `none (nothing eligible)` with per-lane
state lines, exactly as an unfiltered kill with no eligible lanes does. The
returned status table (text and `structuredContent.lanes`) is scoped to the
filtered lanes; an unfiltered kill reports the whole wave.

### `collect`

For each finished lane, writes the final assistant message (text blocks
concatenated) to `<wave>-<name>.md`. Entries carry
`{ name, artifact, suspect, suspectCause, stopReason }`; `suspect: true` when
the lane failed, the message is empty, or the stop reason was not clean —
`suspectCause` names the first applicable of `failed:<cause>`
(killed/deadline/crashed), `empty`, `stop:<stopReason>`. The cause string is
informational rendering, not a frozen vocabulary; the boolean is the stable
flag. Treat a suspect artifact as **not done** and read the file only to judge
it, don't paste it back into the conversation. A refused lane (still running /
never spawned) is a **successful** tool result carrying a per-lane `reason`,
not an error.

`inlineMaxBytes: N` (default 0 — never inline) inlines a non-suspect lane's
artifact content after its line in the text output when the artifact is ≤ N
bytes, fenced with one more backtick than the content's longest fence run
(`max(3, longest + 1)` — scout artifacts contain code blocks; a fixed fence
would terminate early). Over N bytes, the content truncates at the last
complete character within the first N bytes — never a split multibyte
character — and ends with `… [truncated, total B bytes — read <artifactPath>
for the rest]` inside the fence. Suspect artifacts never inline, whatever N
is. Artifact content never enters `structuredContent` — it stays paths and
flags; collection and the `release` consumption marker are unchanged whether
or not anything inlined.

In the TUI, a collect result is expandable (ctrl+o / click): the collapsed
block shows the collect text as-is; the expanded block markdown-renders
each collected lane's artifact from a snapshot taken at collect time,
capped at 16 kB per lane — the block stays honest after `release` deletes
the artifacts, and no file I/O runs in the render path. The snapshot rides
the result's `details` channel: it never reaches the model but is persisted
into the session transcript, and repeated `collect` calls repeat the
snapshot.

A `lane: [names]` filter collects exactly those lanes — the kill-then-collect
flow consumes the settled siblings without re-walking the killed lane's
refusal or previously collected lanes. Partial collection composes with
`release` unchanged: the release refusal names the unconsumed remainder until
each spawned lane's artifact exists.

### `release`

Cleanup as a tool boundary: deletes exactly the wave's manifest-enumerated
files (brief, events, `.err`), its collect artifacts (`<wave>-<name>.md`),
and the manifest itself — nothing else, no globs. Files already deleted
among the enumerated set are tolerated (idempotent). Result:
`{ wave, deleted[], absent }`.

Refused (a thrown error, wave retained) when:

- the wave is not settled/failed yet — `wait` or `kill` first;
- a spawned lane's events file exists without its collect artifact — an
  unconsumed transcript; `collect` first. Keyed on events presence, so a wave
  whose events files are already gone stays releasable (idempotent);
- the manifest's `owner` names a **live foreign session** (same host, pid
  alive with matching start-time) — only the dispatching session, or any
  session once the owner is provably dead, may release;
- the owner is on a **different host** — neither live nor provably dead
  from this host;
- the owner record is missing or malformed (pre-owner manifests) — fail
  closed, never guessed.

The refusals bind sessions, not people: a human may always delete by hand.

### Recovering partial work

The events file `<wave>-<name>.events.jsonl` is pi's documented JSON event
stream (pi's JSON event-stream docs are its canonical reference) and holds
the lane's full transcript — every assistant message and tool result — until
`release` deletes it. A failed lane (deadline, killed, crashed) therefore
loses nothing that reached the stream: salvage it by dispatching a cheap
reader lane whose brief points at the events file, or grep it by hand.
`collect`'s artifact is the **last** assistant message only — for a failed
lane it is a fragment, not the findings; treat it as suspect.

A slow lane is diagnosed from its tail, not its head:
`bash tail -c 2000 <workDir>/<wave>-<name>.events.jsonl` —
`tool_execution_start`/`_end` pair by `toolCallId` (an unmatched start is an
in-flight tool), and `agent_settled` marks the end. There is no `peek`
action by design; the general tools are the diagnosis surface. Wave
discovery stays `ls <workDir>/*-manifest.json`.

## Status bar & `/lanes`

The statusbar footer and the `/lanes` command are TUI conveniences over
the same derived state the `lanes` tool reports; `--print`/`--mode json`
sessions see status through the tool alone.

### Status bar

While any tracked lane runs — or has failed and the wave is not yet
released — the footer shows one line. Segments sit in a fixed order,
empty ones dropped: `[telemetry | running-count] · [idle/overdue badge] ·
[failed badge] · [settled/failed counts]`.

- A `running` lane silent for ≥ 60s badges `(N idle Ms)` with its honest
  last-event age (a lane past its deadline badges overdue instead) — a
  signal, not a verdict: a lane legitimately inside a long `bash` run
  trips it too.
- A lane past its deadline badges `(N overdue)` — the kill-and-redispatch
  discipline still decides.
- An unreleased failure keeps the footer (and its poll tick) alive until
  the wave is released; a fully settled wave clears it.
- When exactly one lane is running, the count becomes micro-telemetry:
  `lanes [survey/docs]: running (turn 3 · bash · last 12s)` — the
  in-flight tool from the latest unmatched `tool_execution_start`; start
  events carry no timestamp, so no tool age is shown.

### `/lanes`

Three forms:

- `/lanes` — every wave with a manifest in the default workDir plus this
  session's tracked workDirs: lane count, aggregate state, a
  `(prior session)` tag on waves from a dead or unidentifiable
  dispatcher, corrupt manifests listed with their error. Ends with the
  grammar line. With exactly one readable wave scanned, bare `/lanes`
  skips the listing and shows that wave's table (prior-session waves
  included — any session may re-adopt).
- `/lanes <wave>` — the per-lane table under a wave header (wall clock
  since dispatch, summed tokens and cost).
- `/lanes <wave> <lane>` — single-lane inspector by state: settled lanes
  show metadata, a recent tool trace, and the artifact (or `not yet
  collected`); running lanes show the live trace — tool names with
  one-line 80-char argument snippets, the open tool marked in flight,
  the last assistant text; failed lanes show cause, `.err` tail, and
  transcript/err paths.

Failed lanes in the wave table also list their transcript and `.err`
paths, clickable when the terminal proves capable (pi's own OSC 8 gate —
`PI_HYPERLINKS` overrides; plain absolute/`~` paths otherwise). A click
opens the absolute `file://` target — it works exactly where the
terminal's machine can reach the file, so under SSH+tmux the paths are
for copy-paste. Completion is two-level: wave slugs first, then lane
slugs of the selected wave. The list follows letters and Space while you
type; Tab or Enter applies the highlighted row (Tab can never open the
list — the host routes it to command-name or file completion); after an
apply, type a letter or Backspace to reopen, and if Tab ever showed file
paths, Esc once then a letter returns to wave/lane completion. Each
table line tags the lane with its model — short id (provider prefix
dropped), `think:<level>` appended when set; `[default]` for a no-pin
lane that hasn't started generating.

Worked example: `dispatch` a two-lane scout wave; with no other wave
around, bare `/lanes` shows the scout table itself; once the footer
shows the lanes settled, `/lanes scouts docs` reads the artifact in the
TUI — zero model tokens.

## Configuration

The lane protocol itself is fixed — every lane runs `--mode json --no-session
-ns` (fresh process, JSON event stream, skills unloaded) — while every
**variable** knob is configurable. JSON files, later wins:

1. defaults (documented in the tables above)
2. `<agent-dir>/pi-minimal-dispatch.json` — user level (`~/.pi/agent`, or `$PI_CODING_AGENT_DIR`)
3. `.pi/pi-minimal-dispatch.json` — project level (working directory)
4. per-call tool parameters

| Key | Type | Default | Description |
|---|---|---|---|
| `workDir` | string | `.pi/work` | Default wave directory |
| `deadlineSec` | number | `900` | Default lane leash (integer ≥ 1) |
| `killGraceMs` | number | `5000` | SIGTERM→SIGKILL grace in the `kill` action; also the leash's `timeout -k` escalation (integer ≥ 100) |
| `pollMs` | number | `2000` | Poll interval for `wait`'s re-derive cadence and the statusbar (integer ≥ 100) — the knob for failure-detection latency in `wait` |
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
