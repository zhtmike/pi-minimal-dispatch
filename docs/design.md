# Design notes

Why pi-minimal-dispatch looks the way it does. The contract itself lives in
the [README](../README.md) (lean overview) and [api.md](api.md) (full
reference); this document records the positioning, the design decisions,
and the compatibility posture.

## Positioning

pi ships no sub-agents by design — its README: "skips features like
sub-agents and plan mode. Ask Pi to build what you want, or install a
package that does it your way." Most packages that answer grow an agent
cast: persona rosters with per-role system-prompt markdown, concurrency
pools and spawn budgets, fleet UIs, hub servers or daemons that must
stay alive. Checked against the pi package listing (surveyed 2026-10-26;
primary sources: each package's own registry entry and README).

pi-minimal-dispatch takes the other end of the trade on every axis: no
persona layer at all, detached OS processes instead of in-process sessions
or a hub, no concurrency machinery, zero runtime dependencies. The
honest edges of that comparison: some extensions also keep state in plain
files (transcripts, schedules), and detached background runners exist too —
what none of the surveyed packages combine is *detached lanes +
file-only re-adoptable state + caller-decided count + no persona layer* in
one deliberately small surface.

## Design pillars

1. **No personas, no role play.** A lane is a brief file plus optional
   `model`/`thinking` pins — no agent roster, no per-role system prompts,
   no character frontmatter. The dispatching agent keeps the judgment: it
   writes each brief, so it decides what each lane is. Persona frameworks
   encode yesterday's division of labor; briefs encode today's.
2. **The filesystem is the whole protocol.** Briefs in, per-lane JSONL
   event streams, one JSON manifest, `<wave>-<name>.md` artifacts out. No
   hub, no broker, no in-memory runtime state. Any process — including a
   session that never dispatched — can read, re-adopt, or collect a wave
   from plain files; `grep` is a valid monitoring tool.
3. **The caller decides how many lanes.** No queue, no pool, no cap in
   the tool: every lane in a `dispatch` call is spawned at once. External
   limits (OS processes, provider rate limits) still apply — pacing is
   the caller's discipline, not the tool's. A rate-limited provider means
   the caller dispatches sequentially; the tool refuses to guess that for
   it.
4. **Zero runtime dependencies.** Node builtins plus a small host-API
   surface: `defineTool`, `Type`, `StringEnum` from `@earendil-works/pi-ai`;
   `registerTool`, `registerCommand`, `on("session_start"|"session_shutdown")`,
   and `ctx.ui.setStatus` from the pi host. Plain TypeScript, no build
   step (pi runs extensions via jiti).

## Mechanics

- **Lane**: detached via an argv array (no `sh -c` wrapper to mangle) in its
  own process group; the `timeout` wrapper is the deadline leash, so it holds
  even when the dispatcher is gone.
- **Registry**: `<workDir>/<wave>-manifest.json`, created atomically (`wx` —
  slug collisions and concurrent same-wave dispatches fail loudly). Plain
  JSON on disk: pids, process start-times, deadlines, brief paths, and the
  dispatcher's owner record (session id, pid, host, start-time) — everything
  a later session needs to re-adopt the wave. Cleanup stays an explicit
  step — now `release`: it deletes exactly the manifest's enumerated paths
  plus collect artifacts and the manifest itself, refusing unsettled and
  foreign-owned waves.
- **State**: derived on every call from the event stream, PID liveness, and
  the deadline — never stored, never stale. The statusbar and `/lanes` are
  TUI conveniences over this derived state; `--print`/`--mode json` sessions
  see status through the `lanes` tool alone.

## Non-goals

No queueing, no steering, no fleet UI — each is a real feature somewhere in
the ecosystem and deliberately absent here. Steering is kill + redispatch
(briefs are files: refine and re-run under a new slug). Queueing hides the
caller's pacing decisions inside the tool where they can't be audited. A
fleet UI is what the statusbar line and `/lanes` already cover in the
deliberate extent. When one of these stops feeling like a cut, that is the
signal to re-read the positioning above, not to grow the surface.

## Compatibility posture

- **Floor**: pi ≥ 1.4.0, Node ≥ 22.19.0, POSIX only (process groups, `ps`
  `-o lstart=`, GNU `timeout`). CI typechecks the host-API surface against
  both the 1.4.0 floor and latest pi.
- **What can break**: the lane protocol rides pi's CLI flags
  (`--mode json --no-session -ns -ne --tools --no-mcp --model --thinking`)
  and JSON event stream (`session` header, `message_start`/`message_end`,
  `agent_settled`). Both have changed within pi's 1.x line before —
  `--tools` semantics moved in 1.0.4 (patterns, `mcp__` entries) and 1.1.0
  (`+name`/`-name` modifiers, which this extension rejects at the tool
  boundary precisely because they silently widen the default selection).
  pi makes no extension-API stability promise; compatibility beyond the
  tested floor is best-effort, verified by the canary CI leg, not assumed.

## Origin

Hand-written bash dispatch (`pi --print @brief > out.md &`) leaves the
dispatcher blind: the artifact stays empty until the lane exits (working
and hung look identical), killing means signaling a wrapper PID of unclear
ownership, a mangled spawn line dies silently, and truncation, crash, and
never-started are indistinguishable after the fact. Everything in the
current surface — detached process groups, the `timeout -k` leash, the
manifest, derived state — exists to make those four failures visible
instead of silent.
