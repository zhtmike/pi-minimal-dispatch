/**
 * pi-minimal-dispatch derived-state core — manifest, lane event parsing, state derivation.
 * Pure Node builtins: importable and testable without the pi host. Contract: README.md.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_DEADLINE_SEC = 900;
export const KILL_GRACE_MS = 5000;

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
	lanes: LaneRecord[];
};

export type LaneStatus = {
	name: string;
	state: "starting" | "running" | "settled" | "failed";
	cause?: "spawn" | "killed" | "deadline" | "crashed";
	overdue?: boolean;
	turns: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	stopReason?: string;
	lastEventAgeSec: number | null;
	spawnError?: string;
	errTail?: string;
};

// --- manifest --------------------------------------------------------------

export function manifestPathFor(workDir: string, wave: string): string {
	return path.join(workDir, `${wave}-manifest.json`);
}

export function readManifest(workDir: string, wave: string): Manifest {
	const p = manifestPathFor(workDir, wave);
	if (!fs.existsSync(p)) throw new Error(`unknown wave '${wave}' (no manifest at ${p})`);
	return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
}

export function writeManifestAtomic(m: Manifest): void {
	const p = manifestPathFor(m.workDir, m.wave);
	const tmp = `${p}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(m, null, "\t"));
	fs.renameSync(tmp, p);
}

// --- process liveness ------------------------------------------------------

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
	const actual = psLstart(pid); // empty output = dead
	return actual !== "" && actual === expectedStart;
}

// --- event parsing ---------------------------------------------------------

/**
 * Parse a lane's JSONL event stream. A trailing line lacking its newline is a
 * SIGTERM-truncated write and is skipped; any other unparseable line is
 * corruption and throws.
 */
export function parseEvents(eventsPath: string): any[] {
	if (!fs.existsSync(eventsPath)) return [];
	const raw = fs.readFileSync(eventsPath, "utf8");
	if (raw === "") return [];
	const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n").slice(0, -1);
	const events: any[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === "") continue;
		try {
			events.push(JSON.parse(lines[i]));
		} catch (e: any) {
			throw new Error(`corrupt event line ${i + 1} in ${eventsPath}: ${e.message}`);
		}
	}
	return events;
}

function errTailFor(lane: LaneRecord): string | undefined {
	if (!fs.existsSync(lane.errPath)) return undefined;
	const err = fs.readFileSync(lane.errPath, "utf8").trim();
	return err === "" ? undefined : err.split("\n").slice(-5).join("\n");
}

// --- state derivation ------------------------------------------------------

/** Derive a lane's status from its events file, PID liveness, and manifest facts. Never stored. */
export function deriveLane(lane: LaneRecord, now: number): LaneStatus {
	const base: LaneStatus = {
		name: lane.name,
		state: "failed",
		turns: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		lastEventAgeSec: null,
	};

	if (!lane.spawned) return { ...base, cause: "spawn", spawnError: lane.spawnError };

	const events = parseEvents(lane.eventsPath);
	for (const e of events) {
		if (e.type === "turn_start") base.turns++;
		if (e.type === "message_end" && e.message?.role === "assistant") {
			const u = e.message.usage ?? {};
			base.usage.input += u.input ?? 0;
			base.usage.output += u.output ?? 0;
			base.usage.cacheRead += u.cacheRead ?? 0;
			base.usage.cacheWrite += u.cacheWrite ?? 0;
			base.usage.cost += u.cost?.total ?? 0;
			if (typeof e.message.stopReason === "string") base.stopReason = e.message.stopReason;
		}
	}
	if (fs.existsSync(lane.eventsPath)) {
		base.lastEventAgeSec = Math.round((now - fs.statSync(lane.eventsPath).mtimeMs) / 100) / 10;
	}

	const pastDeadline = now > Date.parse(lane.startedAt) + lane.deadlineSec * 1000;

	if (events.some((e) => e.type === "agent_settled")) return { ...base, state: "settled" };

	const alive = lane.pid !== null && pidAlive(lane.pid, lane.processStart);
	if (!alive) {
		if (lane.killedAt) return { ...base, cause: "killed" };
		if (pastDeadline) return { ...base, cause: "deadline" };
		return { ...base, cause: "crashed", errTail: errTailFor(lane) };
	}

	return {
		...base,
		state: events.some((e) => e.type === "session") ? "running" : "starting",
		overdue: pastDeadline,
	};
}

/** Final assistant message text (concatenated text blocks of the last assistant message_end). */
export function finalAssistantText(events: any[]): string {
	let text = "";
	for (const e of events) {
		if (e.type === "message_end" && e.message?.role === "assistant") {
			const blocks = Array.isArray(e.message.content) ? e.message.content : [];
			text = blocks
				.filter((b: any) => b.type === "text" && typeof b.text === "string")
				.map((b: any) => b.text)
				.join("\n");
		}
	}
	return text;
}

// --- presentation ----------------------------------------------------------

export function formatLaneLine(s: LaneStatus): string {
	const bits = [s.name, s.state];
	if (s.cause) bits.push(`(${s.cause}${s.spawnError ? `: ${s.spawnError}` : ""})`);
	if (s.overdue) bits.push("OVERDUE");
	bits.push(`${s.turns} turns`);
	bits.push(`tok ${s.usage.input}in/${s.usage.output}out, $${s.usage.cost.toFixed(4)}`);
	if (s.stopReason !== undefined) bits.push(`stop:${s.stopReason}`);
	if (s.lastEventAgeSec !== null) bits.push(`last ${s.lastEventAgeSec}s ago`);
	return `  ${bits.join(" · ")}` + (s.errTail ? `\n    err: ${s.errTail.replace(/\n/g, "\n    ")}` : "");
}

export function formatWaveStatus(wave: string, statuses: LaneStatus[]): string {
	return `wave '${wave}':\n${statuses.map(formatLaneLine).join("\n")}`;
}

/** Footer summary across tracked waves; undefined when nothing is in flight — clear the status entry. */
export function formatStatusBarSummary(statuses: LaneStatus[]): string | undefined {
	let running = 0;
	const done: Record<string, number> = {};
	for (const s of statuses) {
		if (s.state === "running" || s.state === "starting") running++;
		else done[s.state] = (done[s.state] ?? 0) + 1;
	}
	if (running === 0) return undefined;
	const parts = [`${running} running`];
	for (const [k, v] of Object.entries(done).sort()) if (v > 0) parts.push(`${v} ${k}`);
	return `lanes: ${parts.join(" · ")}`;
}
