# Changelog

## Unreleased

- A failed lane's work is no longer destroyed with it: `release` refuses while
  a spawned lane's events file (pi's documented JSON event stream — the full
  transcript, every assistant message and tool result) exists without its
  collect artifact — an unconsumed transcript; `collect` first, and a human
  may always delete by hand. Keyed on events presence, so a partially deleted
  wave stays releasable, and a lane that never spawned (which `collect`
  refuses) never blocks. docs/api.md gains "Recovering partial work": salvage
  is a reader lane over the events file or a hand grep — `collect`'s artifact
  for a failed lane is the last assistant message only. The `thinking` pin is
  documented as clamped to the model's capabilities (status reports the
  actual level).

## 0.3.2 — 2026-10-27

- Wave cleanup became a tool boundary: the manifest records the dispatcher's
  owner identity (session id, pid, host, `ps` start-time, captured before the
  slug claim), and on that record `kill` refuses a wave owned by a live
  foreign session while the new `lanes action=release` replaces hand-deletion
  — it deletes exactly the wave's manifest-enumerated files plus its collect
  artifacts and the manifest, refusing unsettled, foreign-owned, and
  unattributable waves (pre-owner manifests fail closed; every refusal names
  the human override). Concurrent sessions sharing a workDir no longer risk
  each other's state through `rm` and prefix globs.
- `dispatch` fails a lane early whose brief carries a fenced
  `bash`/`sh`/`shell`/`zsh` block while its `tools` grants no `bash` — the
  mismatch used to surface only mid-run, after the dispatcher stopped
  looking. Quoted output in a `text` fence never demands `bash`.
- `tests/prove.sh` is gone: a live run bills models, and nothing scripted
  replaces it.

## 0.3.1 — 2026-10-26

- Status tags never go silent: an assistant `message_start` reveals the
  answering model the moment generation begins (pi builds the message with
  the model id at start), so a lane that pins no model shows its identity
  before the first answer; and a lane still pre-generation that pins neither
  `model` nor `thinking` renders `[default]` instead of no tag — omitted pins
  inherit pi's configured default, which is worth saying out loud rather
  than reading as "no model / broken". `message_start` is additive: it
  carries no thinking level, so a pinned level stands until the first
  `message_end` confirms or replaces it.

## 0.3.0 — 2026-10-26

- `dispatch` lanes accept `thinking` — pin a lane's thinking level
  (`off`…`max`, pi's `--thinking` vocabulary) independently of `model`.
  Precedence mirrors pi: an explicit `thinking` wins over any `id:thinking`
  suffix on `model`; the pinned level shows in status tags until the lane's
  first answer.
- CI/CD: GitHub Actions `Tests` (zero-install unit tests on the exact node
  floor, host-API typecheck against pi 1.4.0, latest-pi canary) and
  `Release` (tag-driven, guarded, `npm publish --provenance` via OIDC
  trusted publishing). The repo stays dependency-free — CI toolchains
  install ephemerally.

## 0.2.1 — 2026-10-26

- Status lines (`lanes` status/wait, `/lanes`) tag each lane with its model:
  `[short-id think:level]` after the name — provider prefix dropped, thinking
  level only when set. The tag shows the actual model from the lane's last
  assistant message, falling back to the pinned value until the first answer;
  `LaneStatus` carries `model`/`thinkingLevel` (full ids) for structured
  consumers.
- `dispatch`'s `model` param documents pi's `id:thinking` suffix
  (e.g. `zai/glm-4.6:high`), which the tag renders split off the id.

## 0.2.0 — 2026-10-23

Requires pi ≥ 1.4.0 (the MCP reach rules the validator encodes are pi
1.4.0's documented `--tools` semantics).

- `dispatch` no longer spawns blind MCP lanes: with MCP enabled, a lane whose
  `tools` allowlist names neither `codemode` nor `tool_search` is rejected at
  the tool boundary — pi's `--tools` allowlist replaces the whole selection,
  and a lane never reaches MCP tools through anything else unless the server
  has `direct` exposure (which dispatch cannot know). Pass `codemode`/
  `tool_search` in `tools` or set `mcp: false`.
- `tools` now accepts only a plain allowlist: `+name`/`-name` modifier lists
  (pi applies them to its default selection, silently granting
  `bash`/`edit`/`write`) and empty lists are rejected.
- README and docs/API.md document the reach rule and both reach recipes; the
  `mcp` schema text no longer claims MCP tools "stay reachable" by default.

- `lanes` gained `action: "wait"` (+ `waitSec`, default 300, max 3600):
  holds one call open, re-deriving at the `pollMs` cadence, until every lane
  is terminal — replaces blind sleep-then-status polling (which wakes late
  after settles); times out as a normal status result, honors cancellation.

## 0.1.0 — 2026-10-23

Initial release. Requires pi ≥ 1.3.0 (1.4.0 recommended — see README).

- `dispatch` tool: detached lane spawning (own process group, argv array, no
  shell wrapper) with synchronous brief/slug validation, atomic wave-slug
  claim, per-lane model/deadline/tool allowlist, and a parentless deadline
  leash (`timeout -k`).
- `lanes` tool: stateless status/kill/collect over a wave's manifest + JSON
  event streams — derived state with failure causes, start-time-guarded PID
  liveness, TERM→KILL group kill with tombstones, and suspect-flagged
  artifact collection.
- Safe defaults: lanes run read-only (`read,grep,find,ls`) unless granted
  more via `tools`, never load skills (`-ns`), and never receive the
  `dispatch` tool themselves (child marker).
- Statusbar line and `/lanes` command (TUI/RPC modes).
- Configuration: user/project JSON files with per-call parameter precedence.
