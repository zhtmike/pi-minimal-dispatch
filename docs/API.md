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
| `lanes[].thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max`? | none | Pin a thinking level (pi's `--thinking`); wins over any `:level` suffix in `model` |
| `lanes[].deadlineSec` | number? | `deadlineSec` config (900) | Leash in seconds; holds even if the dispatcher is gone. Minimum 1 |
| `lanes[].tools` | string? | `read,grep,find,ls` | Tool allowlist for `--tools` — plain names or `*` patterns; no `+name`/`-name` modifiers, no shell quoting, not empty. Add `bash` when a lane must run commands (bash can still invoke git). With MCP enabled, reach requires `codemode` or `tool_search` here — see [MCP and web reach](#mcp-and-web-reach) |
| `lanes[].noExtensions` | boolean? | false | Pass `-ne` (drop extensions incl. MCP in the lane) |
| `lanes[].mcp` | boolean? | enabled | Set `false` to pass `--no-mcp` (no MCP servers connect). With MCP enabled, `tools` must name `codemode` or `tool_search` or the call is rejected — servers connecting alone never declares MCP tools to the lane |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory for manifest, events, and artifacts |

**Result:** text summary plus `structuredContent` — `{ wave, manifestPath, lanes[] }`
with each lane's pid, paths, and deadline. Spawned lanes stream events
immediately; a lane that failed to spawn appears as `SPAWN ERROR: …`.

**Errors** (the whole call fails, zero lanes spawned, no slug claimed):
a brief file missing (all missing paths listed) · malformed or duplicate slugs ·
`tools` that is not a plain allowlist (`+name`/`-name` modifiers, shell quoting,
or an empty list) · a lane leaving MCP enabled while its `tools` names neither
`codemode` nor `tool_search` · wave slug already exists · `timeoutBin`/`piBin`
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
| `action` | string? | `"status"` | `"status"` \| `"wait"` \| `"kill"` \| `"collect"` |
| `waitSec` | number? | `300` | `wait` only: max seconds to hold the call open (1–3600) |
| `workDir` | string? | `workDir` config (`.pi/work`) | Directory holding the manifest |

### `status`

Per-lane `structuredContent` entries. Note: `settled` only means the
`agent_settled` event was seen — success is `collect` returning
`suspect: false`.

| Field | Type | Meaning |
|---|---|---|
| `name` | string | lane slug |
| `state` | string | `starting` \| `running` \| `settled` \| `failed` |
| `cause` | string? | for `failed`: `spawn` · `killed` · `deadline` · `crashed` |
| `overdue` | boolean? | alive past its deadline (leash misfire) — informational |
| `turns` | number | turn count so far |
| `usage` | object | run totals summed over assistant messages: `{input, output, cacheRead, cacheWrite, cost}` |
| `model` | string? | model answering the last assistant message; earlier, the model from the lane's assistant `message_start` (pi sets it when generation begins); before that, the pinned model with pi's `:thinking` suffix split off (last colon, valid level word only). `undefined` only pre-generation on a lane that pins no model |
| `thinkingLevel` | string? | thinking level of the last assistant message (`off`–`max`); until the first message_end, the pinned level — explicit `thinking` over the model's `:level` suffix (`message_start` carries no level, so a pinned one stays) |
| `stopReason` | string? | last assistant stop reason (`stop` is clean) |
| `lastEventAgeSec` | number? | seconds since the events file last grew — the stuck-lane signal |
| `spawnError` | string? | why a `spawn`-failed lane never started |
| `errTail` | string? | last lines of `.err` for `crashed` lanes |

### `wait`

Holds the tool call open, re-reading the manifest and re-deriving state every
`pollMs`, until every lane is terminal (`settled` or `failed`), `waitSec`
(default 300, max 3600) elapses, or the call is cancelled — then returns
exactly the `status` payload. A timeout is **not** an error: lanes still
running show as `running`, and the caller waits again (or proceeds to
`kill`/`collect`, which refuse running lanes as usual). This replaces
sleep-then-status polling, which guesses the duration and wakes late after a
settle. `dispatch` still returns in under a second — blocking is always this
explicit, bounded observation call, and the deadline leash needs no observer.

### `kill`

SIGTERM to each eligible lane's process group (never a
start-time-mismatched/reused PID; settled lanes skipped), SIGKILL after the
`killGraceMs` config grace, then a manifest tombstone so the kill survives
re-adoption. Idempotent; honors tool-call cancellation during the grace wait.

### `collect`

For each finished lane, writes the final assistant message (text blocks
concatenated) to `<wave>-<name>.md`. Entries carry
`{ name, artifact, suspect, stopReason }`; `suspect: true` when the lane
failed, the message is empty, or the stop reason was not clean — treat such an
artifact as **not done** and read the file only to judge it, don't paste it
back into the conversation. A refused lane (still running / never spawned) is
a **successful** tool result carrying a per-lane `reason`, not an error.

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
