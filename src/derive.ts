/**
 * pi-minimal-dispatch derived-state core — manifest registry, process
 * liveness, and lane state derivation. Pure Node builtins: importable and
 * testable without the pi host. Contract: README.md + docs/API.md.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { type LaneEvent, type StreamMessage, assistantMessageEnd, assistantMessageStart, messageText, parseEvents, parseEventsTail } from "./events.ts";

export type LaneRecord = {
	name: string;
	briefPath: string; // absolute
	eventsPath: string;
	errPath: string;
	pid: number | null;
	processStart: string | null; // `ps -o lstart=` captured at spawn
	startedAt: string; // ISO, stamped at creation
	deadlineSec: number;
	model?: string;
	/** Pinned thinking level from the dispatch call; wins over the model's `:level` suffix. */
	thinking?: string;
	tools?: string;
	spawned: boolean;
	spawnError?: string;
	killedAt?: string; // tombstone — the only post-spawn write
};

export type Manifest = {
	version: 1;
	wave: string;
	workDir: string;
	createdAt: string;
	/** Dispatcher identity, stamped at claim time — the release/kill ownership guard. */
	owner?: WaveOwner;
	lanes: LaneRecord[];
};

/** Dispatcher identity recorded at dispatch; `lstart` is `ps -o lstart=` captured then. */
export type WaveOwner = {
	sid: string;
	pid: number;
	host: string;
	lstart: string;
};

export type LaneFailureCause = "spawn" | "killed" | "deadline" | "crashed";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };

export type LaneStatus = {
	name: string;
	state: "starting" | "running" | "settled" | "failed";
	cause?: LaneFailureCause;
	/** Set while a lane is alive past its deadline (leash misfire) — informational. */
	overdue?: boolean;
	turns: number;
	usage: Usage;
	/** Model answering the last assistant message; before the first, the pinned model (pi's `id:thinking` suffix split off). */
	model?: string;
	/** Thinking level of the last assistant message; before the first, the pinned level (explicit `thinking` over the model's suffix). */
	thinkingLevel?: string;
	/** Latest `tool_execution_start` with no matching `_end` yet — the tool running right now. */
	inflightTool?: string;
	stopReason?: string;
	lastEventAgeSec: number | null;
	spawnError?: string;
	errTail?: string;
};

// --- manifest --------------------------------------------------------------

/** Path of a wave's manifest inside its workDir. */
export function manifestPathFor(workDir: string, wave: string): string {
	return path.join(workDir, `${wave}-manifest.json`);
}

/** Read and parse a wave manifest; throws with the path when absent or invalid. */
export function readManifest(workDir: string, wave: string): Manifest {
	const p = manifestPathFor(workDir, wave);
	const unknown = new Error(`unknown wave '${wave}' (no manifest at ${p}) — list live waves: ls ${path.dirname(p)}/*-manifest.json`);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf8");
	} catch (e: any) {
		if (e.code === "ENOENT") throw unknown;
		throw e;
	}
	if (raw === "") throw new Error(`manifest for wave '${wave}' at ${p} is empty — a dispatch may be mid-publish; retry`);
	try {
		return JSON.parse(raw) as Manifest;
	} catch (e: any) {
		throw new Error(`invalid manifest JSON at ${p}: ${e.message}`);
	}
}

/** Atomically replace a wave manifest (pid-suffixed tmp, same-fs rename). */
export function writeManifestAtomic(m: Manifest): void {
	const p = manifestPathFor(m.workDir, m.wave);
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(m, null, "\t"));
	fs.renameSync(tmp, p);
}

// --- process liveness ------------------------------------------------------

/** Process start-time per `ps -o lstart=`; empty string means the pid is dead. */
export function psLstart(pid: number): string {
	try {
		return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
	} catch {
		return ""; // a dead pid makes ps exit nonzero — empty means dead, never an exception
	}
}

/** PID alive AND its start-time still matches — a reused PID is a different process, never ours. */
export function pidAlive(pid: number, expectedStart: string | null): boolean {
	let reachable = false;
	try {
		process.kill(pid, 0);
		reachable = true;
	} catch (e: any) {
		if (e.code === "ESRCH") return false;
		// EPERM: exists but not signalable — fall through to the start-time check
	}
	if (expectedStart === null) return reachable;
	const actual = psLstart(pid);
	return actual !== "" && actual === expectedStart;
}

// An out-of-range pid (a foreign-host manifest on a shared workDir) makes BSD ps reject
// the whole batch — drop it instead; it is not a process on this host.
const MAX_PID = process.platform === "darwin" ? 99998 : 4194304;

/**
 * One `ps` listing for many pids: pid → lstart, absent = not running here. A
 * failed listing means no listed pid exists — the same verdict `psLstart`
 * gives a dead pid, never an exception.
 */
export function psLstartBatch(pids: number[]): Map<number, string> {
	const live = [...new Set(pids)].filter((p) => Number.isInteger(p) && p > 0 && p <= MAX_PID);
	if (live.length === 0) return new Map();
	let out: string;
	try {
		out = execFileSync("ps", ["-o", "pid=,lstart=", "-p", live.join(",")], { encoding: "utf8" });
	} catch {
		return new Map();
	}
	const map = new Map<number, string>();
	for (const line of out.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(.+)$/);
		if (m !== null) map.set(Number(m[1]), m[2].trim());
	}
	return map;
}

/** Liveness from a batch probe: listed with a matching start-time (a reused pid shows a different one). */
function probeAlive(probe: Map<number, string>, pid: number, expectedStart: string | null): boolean {
	const actual = probe.get(pid);
	return actual !== undefined && (expectedStart === null || actual === expectedStart);
}

/**
 * Whether any process remains in the group — the kill grace check. The leader
 * may already be dead on SIGTERM while a TERM-immune member lingers; a group
 * probe is the honest survivor test once the leader is gone.
 */
export function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (e: any) {
		return e.code !== "ESRCH"; // EPERM: the group exists
	}
}

// --- wave ownership --------------------------------------------------------

export type OwnerStatus = "own" | "live-foreign" | "foreign-host" | "dead" | "unknown";

/** Owner record for the current dispatcher; throws when ps cannot capture the start-time. */
export function currentOwner(sid: string): WaveOwner {
	const lstart = psLstart(process.pid);
	if (lstart === "") {
		throw new Error("could not capture the dispatcher's process start-time (ps failed) — ownership guards would be blind");
	}
	return { sid, pid: process.pid, host: hostname(), lstart };
}

/**
 * Classify a manifest's owner against the calling session. `unknown` is any
 * absent or malformed record — fail-closed, never treated as dead.
 */
export function ownerStatus(owner: WaveOwner | undefined, selfSid: string, currentHost: string): OwnerStatus {
	if (
		owner == null || // null is a hand-edited manifest — same fail-closed path as absent
		typeof owner.sid !== "string" ||
		owner.sid === "" ||
		!Number.isInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.host !== "string" ||
		owner.host === "" ||
		typeof owner.lstart !== "string" ||
		owner.lstart === ""
	) {
		return "unknown";
	}
	if (owner.sid === selfSid) return "own";
	if (owner.host !== currentHost) return "foreign-host";
	return pidAlive(owner.pid, owner.lstart) ? "live-foreign" : "dead";
}

export type OwnerGuard =
	| { ok: true; owner: "own" | "dead" }
	| { ok: false; owner: OwnerStatus; reason: string };

/**
 * Ownership gate for the destructive actions (kill, release). A foreign-host
 * owner is neither live nor provably dead — retained; the refusals bind
 * sessions, not people — a human may always intervene by hand.
 */
export function ownerGuard(owner: WaveOwner | undefined, selfSid: string, currentHost: string, wave: string): OwnerGuard {
	const status = ownerStatus(owner, selfSid, currentHost);
	switch (status) {
		case "own":
		case "dead": // provable same-host death — the wave is adoptable
			return { ok: true, owner: status };
		case "live-foreign":
			return { ok: false, owner: status, reason: `wave '${wave}' is owned by a live session (sid ${owner!.sid}, pid ${owner!.pid}) — refused; a human may intervene by hand` };
		case "foreign-host":
			return { ok: false, owner: status, reason: `wave '${wave}' is owned by a session on host '${owner!.host}' — neither live nor provably dead from this host; retained — a human may clean up by hand` };
		default:
			return { ok: false, owner: status, reason: `wave '${wave}' has no usable owner record (pre-owner manifest or malformed) — retained; a human may clean up by hand` };
	}
}

/** The one artifact path collect writes, release deletes, and the release guard checks. */
export function artifactPathFor(m: Manifest, lane: LaneRecord): string {
	return path.join(m.workDir, `${m.wave}-${lane.name}.md`);
}

/** Every file a release may delete: manifest-enumerated paths, collect artifacts, the manifest. */
export function releasePaths(m: Manifest): string[] {
	const paths: string[] = [];
	for (const lane of m.lanes) {
		paths.push(lane.briefPath, lane.eventsPath, lane.errPath, artifactPathFor(m, lane));
	}
	paths.push(manifestPathFor(m.workDir, m.wave));
	return paths;
}

/**
 * Spawned lanes whose transcript was never consumed: events file present, collect artifact absent.
 * Keyed on events presence (idempotent release); a never-spawned lane can never be collected.
 */
export function unconsumedTranscripts(m: Manifest): string[] {
	const names: string[] = [];
	for (const lane of m.lanes) {
		if (lane.spawned && fs.existsSync(lane.eventsPath) && !fs.existsSync(artifactPathFor(m, lane))) names.push(lane.name);
	}
	return names;
}

/** Delete exactly `releasePaths(m)`, tolerating already-deleted files. The decision is the caller's. */
export function releaseWave(m: Manifest): { deleted: string[]; absent: number } {
	const deleted: string[] = [];
	let absent = 0;
	for (const p of releasePaths(m)) {
		try {
			fs.unlinkSync(p);
			deleted.push(p);
		} catch (e: any) {
			if (e.code === "ENOENT") absent++;
			else throw e;
		}
	}
	return { deleted, absent };
}

// --- state derivation ------------------------------------------------------

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

const ERR_TAIL_BYTES = 8192;
const ERR_TAIL_LINES = 5;
const ERR_LINE_MAX_CHARS = 300;

/** Last few err lines, byte- and width-bounded — a tail read, never the whole file. */
function errTailFor(lane: LaneRecord): string | undefined {
	let st: fs.Stats;
	try {
		st = fs.statSync(lane.errPath);
	} catch {
		return undefined;
	}
	if (st.size === 0) return undefined;
	const len = Math.min(st.size, ERR_TAIL_BYTES);
	let body: string;
	const fd = fs.openSync(lane.errPath, "r");
	try {
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, st.size - len);
		body = buf.toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
	if (len < st.size) {
		const nl = body.indexOf("\n");
		body = nl === -1 ? "" : body.slice(nl + 1); // the head line is partial — drop it
	}
	const lines = body.trim().split("\n").filter((l) => l !== "");
	if (lines.length === 0) return undefined;
	return lines
		.slice(-ERR_TAIL_LINES)
		.map((l) => (l.length > ERR_LINE_MAX_CHARS ? `${l.slice(0, ERR_LINE_MAX_CHARS)}…` : l))
		.join("\n");
}

// --- incremental transcript cache ------------------------------------------

/** Event-derived transcript facts, independent of manifest identity. */
type LaneFold = {
	turns: number;
	hasSession: boolean;
	settled: boolean;
	usage: Usage;
	/** Most recent model named by message_start or message_end, in stream order. */
	lastModel?: string;
	/** Model of the last message_end that carried one — its thinkingLevel (or its absence) is authoritative. */
	lastEndModel?: string;
	lastEndThinking?: string;
	stopReason?: string;
	/** Open tool calls keyed by id in start order; the last value is the tool running now. */
	openTools: Map<string, string>;
	lastText: string;
};

function emptyFold(): LaneFold {
	return { turns: 0, hasSession: false, settled: false, usage: emptyUsage(), openTools: new Map(), lastText: "" };
}

/** Fold events [from, end) into the accumulator — the single derivation pass over a transcript. */
function foldInto(fold: LaneFold, events: LaneEvent[], from: number): void {
	for (let i = from; i < events.length; i++) {
		const e = events[i];
		if (e.type === "turn_start") fold.turns++;
		// message_start reveals the answering model at generation start; it carries no
		// thinkingLevel — message_end stays the sole level authority.
		const starting = assistantMessageStart(e);
		if (starting !== null && typeof starting.model === "string") fold.lastModel = starting.model;
		const message = assistantMessageEnd(e);
		if (message !== null) {
			const u = message.usage ?? {};
			fold.usage.input += u.input ?? 0;
			fold.usage.output += u.output ?? 0;
			fold.usage.cacheRead += u.cacheRead ?? 0;
			fold.usage.cacheWrite += u.cacheWrite ?? 0;
			fold.usage.cost += u.cost?.total ?? 0;
			if (typeof message.stopReason === "string") fold.stopReason = message.stopReason;
			// The last assistant message carrying a model is authoritative for identity —
			// one without thinkingLevel (a non-thinking model) clears a stale level.
			if (typeof message.model === "string") {
				fold.lastModel = message.model;
				fold.lastEndModel = message.model;
				fold.lastEndThinking = typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined;
			}
			fold.lastText = messageText(message);
		}
		if (e.type === "session") fold.hasSession = true;
		if (e.type === "agent_settled") fold.settled = true;
		if (e.type === "tool_execution_start" && typeof e.toolCallId === "string" && typeof e.toolName === "string") {
			fold.openTools.set(e.toolCallId, e.toolName);
		}
		if (e.type === "tool_execution_end" && typeof e.toolCallId === "string") {
			fold.openTools.delete(e.toolCallId);
		}
	}
}

export type LaneEvents = { events: LaneEvent[]; fold: LaneFold; mtimeMs: number | null };

type EventsCacheEntry = {
	/** Bytes confirmed parsed — through the last accepted line; a torn remainder waits here. */
	offset: number;
	size: number;
	mtimeMs: number;
	/** File identity — a recreated file (slug reuse after release) resets the entry. */
	ino: number;
	lineNo: number;
	/** Shared read-only with callers; extended in place as the file grows. */
	events: LaneEvent[];
	fold: LaneFold;
	/** Prefix length of `events` already folded. */
	folded: number;
};

// Events files are append-only with a single writer; anything else — shrink, or a new
// inode from release + slug reuse — resets the entry. Past the cap the table clears.
const eventsCache = new Map<string, EventsCacheEntry>();
const EVENTS_CACHE_MAX = 64;

/**
 * A lane's parsed transcript and derived fold, stat-gated and extended from the
 * last confirmed byte — an unchanged file costs one stat, a growing one parses
 * only its appended lines. Throws on a corrupt line.
 */
export function laneEvents(eventsPath: string): LaneEvents {
	let st: fs.Stats;
	try {
		st = fs.statSync(eventsPath);
	} catch {
		eventsCache.delete(eventsPath);
		return { events: [], fold: emptyFold(), mtimeMs: null };
	}
	let entry = eventsCache.get(eventsPath);
	if (entry !== undefined && (st.size < entry.offset || st.ino !== entry.ino)) entry = undefined; // replaced
	if (entry !== undefined && st.size === entry.size && st.mtimeMs === entry.mtimeMs) {
		return { events: entry.events, fold: entry.fold, mtimeMs: st.mtimeMs };
	}
	const from = entry?.offset ?? 0;
	let tail: string;
	if (from === 0) {
		tail = fs.readFileSync(eventsPath, "utf8");
	} else {
		const len = st.size - from;
		const buf = Buffer.alloc(len);
		const fd = fs.openSync(eventsPath, "r");
		try {
			fs.readSync(fd, buf, 0, len, from);
		} finally {
			fs.closeSync(fd);
		}
		tail = buf.toString("utf8");
	}
	const events = entry?.events ?? [];
	const before = events.length;
	let parsed: { consumed: number; lineNo: number };
	try {
		parsed = parseEventsTail(tail, events, entry?.lineNo ?? 0, eventsPath);
	} catch (e) {
		events.length = before; // the shared array must not keep a half-extended prefix
		throw e;
	}
	const fold = entry?.fold ?? emptyFold();
	foldInto(fold, events, entry?.folded ?? 0);
	if (eventsCache.get(eventsPath) === undefined && eventsCache.size >= EVENTS_CACHE_MAX) eventsCache.clear();
	eventsCache.set(eventsPath, { offset: from + parsed.consumed, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, lineNo: parsed.lineNo, events, fold, folded: events.length });
	return { events, fold, mtimeMs: st.mtimeMs };
}

// --- lane status ------------------------------------------------------------

/** Manifest-fact base for a lane no transcript could be derived for. */
function bareStatus(lane: LaneRecord): LaneStatus {
	const pinned = lane.model?.match(/^(.+):(off|minimal|low|medium|high|xhigh|max)$/);
	return {
		name: lane.name,
		state: "failed",
		turns: 0,
		usage: emptyUsage(),
		model: pinned?.[1] ?? lane.model,
		thinkingLevel: lane.thinking ?? pinned?.[2],
		lastEventAgeSec: null,
	};
}

function statMtimeMs(p: string): number | null {
	try {
		return fs.statSync(p).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * Compose a lane's status from its transcript fold, liveness, and manifest
 * facts. Precedence mirrors pi: an explicit --thinking beats the model's
 * `:thinking` suffix, which splits only on the last colon and a valid level
 * word (ids like `qwen3-coder:exacto` keep it).
 */
function laneStatus(lane: LaneRecord, now: number, fold: LaneFold, mtimeMs: number | null, alive: boolean): LaneStatus {
	const pinned = lane.model?.match(/^(.+):(off|minimal|low|medium|high|xhigh|max)$/);
	const base: LaneStatus = {
		name: lane.name,
		state: "failed",
		turns: fold.turns,
		usage: fold.usage,
		model: fold.lastModel ?? pinned?.[1] ?? lane.model,
		thinkingLevel: fold.lastEndModel !== undefined ? fold.lastEndThinking : lane.thinking ?? pinned?.[2],
		lastEventAgeSec: mtimeMs === null ? null : Math.round((now - mtimeMs) / 100) / 10,
	};
	if (fold.stopReason !== undefined) base.stopReason = fold.stopReason;
	if (fold.openTools.size > 0) base.inflightTool = [...fold.openTools.values()].at(-1);

	const pastDeadline = now > Date.parse(lane.startedAt) + lane.deadlineSec * 1000;
	if (fold.settled) return { ...base, state: "settled" };
	if (!alive) {
		if (lane.killedAt) return { ...base, cause: "killed" };
		if (pastDeadline) return { ...base, cause: "deadline" };
		return { ...base, cause: "crashed", errTail: errTailFor(lane) };
	}
	return { ...base, state: fold.hasSession ? "running" : "starting", overdue: pastDeadline };
}

/**
 * Derive a lane's status from its events file, PID liveness, and manifest
 * facts. Without explicit events the stat-gated cache keeps the cost to the
 * appended bytes; a corrupt transcript fails soft per lane — failed/crashed
 * with the parse error as its err tail — so kill, collect, and release stay
 * available for the wave.
 */
export function deriveLane(lane: LaneRecord, now: number, events?: LaneEvent[]): LaneStatus {
	if (!lane.spawned) return { ...bareStatus(lane), cause: "spawn", spawnError: lane.spawnError };
	if (events !== undefined) {
		const fold = emptyFold();
		foldInto(fold, events, 0);
		return laneStatus(lane, now, fold, statMtimeMs(lane.eventsPath), lane.pid !== null && pidAlive(lane.pid, lane.processStart));
	}
	try {
		const s = laneEvents(lane.eventsPath);
		return laneStatus(lane, now, s.fold, s.mtimeMs, lane.pid !== null && pidAlive(lane.pid, lane.processStart));
	} catch (e: any) {
		return { ...bareStatus(lane), cause: "crashed", errTail: `${e.message} — kill/collect/release remain available` };
	}
}

/**
 * Derive a sweep of lanes with one ps probe for the pids whose verdict needs
 * liveness (not settled by events, not tombstoned) — the statusbar tick, wait
 * polls, and scans pay one subprocess per sweep, not one per lane.
 */
export function deriveLanes(lanes: LaneRecord[], now: number): LaneStatus[] {
	const states: (LaneEvents | undefined)[] = lanes.map((l) => {
		if (!l.spawned) return undefined;
		try {
			return laneEvents(l.eventsPath);
		} catch {
			return undefined; // fail-soft per lane in the derive below
		}
	});
	const probe = psLstartBatch(
		lanes
			.filter((l, i) => l.spawned && l.pid !== null && l.killedAt === undefined && states[i] !== undefined && !states[i]!.fold.settled)
			.map((l) => l.pid!),
	);
	return lanes.map((lane, i) => {
		const state = states[i];
		if (!lane.spawned || state === undefined) return deriveLane(lane, now);
		return laneStatus(lane, now, state.fold, state.mtimeMs, lane.pid !== null && probeAlive(probe, lane.pid, lane.processStart));
	});
}

/** Whether every lane of a wave has reached a terminal state (`settled` or `failed`). */
export function waveTerminal(lanes: LaneRecord[], now: number): boolean {
	return deriveLanes(lanes, now).every((s) => s.state === "settled" || s.state === "failed");
}

export type WaitMode = "all" | "hold" | "any";

/**
 * Poll a wave until its wake condition holds — every lane settled or any
 * lane failed (`all`), every lane terminal (`hold`), the first terminal
 * lane (`any`) — `waitMs` elapses, or the signal aborts; returns the final
 * statuses. A failed lane wakes `all` and `any` at the poll cadence —
 * never sat on behind running siblings; `hold` sits out already-known
 * failures while the siblings finish. Re-reads the manifest on every
 * poll — the same derived truth as the status action, held open.
 */
export async function waitForTerminal(
	workDir: string,
	wave: string,
	waitMs: number,
	pollMs: number,
	signal?: AbortSignal,
	mode: WaitMode = "all",
): Promise<LaneStatus[]> {
	const terminal = (s: LaneStatus) => s.state === "settled" || s.state === "failed";
	const deadline = Date.now() + waitMs;
	for (;;) {
		const lanes = readManifest(workDir, wave).lanes;
		const now = Date.now();
		const statuses = deriveLanes(lanes, now);
		const woken =
			mode === "any"
				? statuses.some(terminal)
				: mode === "hold"
					? statuses.every(terminal)
					: statuses.every((s) => s.state === "settled") || statuses.some((s) => s.state === "failed");
		if (woken || now >= deadline || signal?.aborted) {
			return statuses;
		}
		// The sleep races the abort so a cancelled call returns at once, not at the next poll.
		await new Promise<void>((resolve) => {
			const delay = Math.min(pollMs, deadline - now);
			if (signal === undefined) {
				setTimeout(resolve, delay);
				return;
			}
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, delay);
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}
}

/** Final assistant message text (concatenated text blocks of the last assistant message_end). */
export function finalAssistantText(events: LaneEvent[]): string {
	let text = "";
	for (const e of events) {
		const message = assistantMessageEnd(e);
		if (message !== null) text = messageText(message);
	}
	return text;
}

// --- TUI-owned derivation (never wired to the lanes tool) -------------------

/** One tool call in a lane's trace; `inflight` marks a start with no matching end yet. */
export type TraceTool = {
	name: string;
	/** Raw `args` object as the event carried it — presentation snippets it later. */
	args: unknown;
	durationMs?: number;
	inflight?: boolean;
};

/** Recent-activity summary over a lane's parsed events — the inspector's core. */
export type TraceSummary = {
	/** Most recent tool calls, in execution order (a matched start/end is one entry). */
	tools: TraceTool[];
	/** Final assistant text so far — the last assistant message_end's text blocks. */
	lastText: string;
};

/**
 * Derive a lane's recent trace from its events: a start pushes an inflight entry,
 * its matching end (by toolCallId) closes it with durationMs. `maxTools` keeps the tail.
 */
export function deriveTrace(events: LaneEvent[], maxTools = 8): TraceSummary {
	const tools: TraceTool[] = [];
	const byId = new Map<string, TraceTool>();
	for (const e of events) {
		if (e.type === "tool_execution_start" && typeof e.toolCallId === "string" && typeof e.toolName === "string") {
			const tool: TraceTool = { name: e.toolName, args: e.args, inflight: true };
			tools.push(tool);
			byId.set(e.toolCallId, tool);
		}
		if (e.type === "tool_execution_end" && typeof e.toolCallId === "string") {
			const tool = byId.get(e.toolCallId);
			if (tool !== undefined) {
				tool.durationMs = typeof e.durationMs === "number" ? e.durationMs : undefined;
				tool.inflight = undefined;
			}
		}
	}
	return { tools: tools.slice(-maxTools), lastText: finalAssistantText(events) };
}

/** One wave in the scanned listing; `error` carries a read/parse failure, never a drop. */
export type WaveScan =
	| {
			ok: true;
			wave: string;
			workDir: string;
			/** Derivation snapshot at scan time — the listing renders, never re-derives. */
			statuses: LaneStatus[];
			/** Owner is provably a dead session (or a pre-owner manifest), not this one. */
			priorSession: boolean;
			createdAt: string;
		}
	| { ok: false; wave: string; workDir: string; error: string };

/** Wave slugs discoverable in `workDir` from `*-manifest.json` filenames — no parsing, cheap enough for completion. */
export function waveSlugsIn(workDir: string): string[] {
	try {
		return fs
			.readdirSync(workDir)
			.filter((f) => f.endsWith("-manifest.json"))
			.map((f) => f.slice(0, -"-manifest.json".length));
	} catch {
			return []; // unreadable dir = no suggestions, not a crash
	}
}

/**
 * Scan `workDirs` (deduped) for wave manifests, fail-soft per wave: a corrupt
 * manifest is listed with its error. Pure derivation per found wave.
 */
export function scanWaves(workDirs: string[], selfSid: string, currentHost: string, now: number): WaveScan[] {
	const out: WaveScan[] = [];
	const seen = new Set<string>();
	for (const workDir of [...new Set(workDirs)]) {
		for (const wave of waveSlugsIn(workDir)) {
			const key = `${workDir}/${wave}`;
			if (seen.has(key)) continue;
			seen.add(key);
			try {
				const m = readManifest(workDir, wave);
				const owner = ownerStatus(m.owner, selfSid, currentHost);
				out.push({
					ok: true,
					wave,
					workDir,
					statuses: deriveLanes(m.lanes, now),
					priorSession: owner === "dead" || owner === "unknown",
					createdAt: m.createdAt,
				});
			} catch (e: any) {
				out.push({ ok: false, wave, workDir, error: e.message });
			}
		}
	}
	return out.sort((a, b) => a.wave.localeCompare(b.wave));
}

export { parseEvents };
