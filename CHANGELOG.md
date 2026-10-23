# Changelog

## Unreleased

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
