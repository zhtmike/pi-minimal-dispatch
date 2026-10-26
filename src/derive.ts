/**
 * pi-minimal-dispatch derived-state core — manifest registry, process
 * liveness, and lane state derivation. Pure Node builtins: importable and
 * testable without the pi host. Contract: README.md + docs/API.md.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { type LaneEvent, type StreamMessage, assistantMessageEnd, messageText, parseEvents } from "./events.ts";

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
	lanes: LaneRecord[];
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
	if (!fs.existsSync(p)) throw new Error(`unknown wave '${wave}' (no manifest at ${p})`);
	return JSON.parse(fs.readFileSync(p, "utf8")) as Manifest;
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

// --- state derivation ------------------------------------------------------

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function errTailFor(lane: LaneRecord): string | undefined {
	if (!fs.existsSync(lane.errPath)) return undefined;
	const err = fs.readFileSync(lane.errPath, "utf8").trim();
	return err === "" ? undefined : err.split("\n").slice(-5).join("\n");
}

/** Derive a lane's status from its events file, PID liveness, and manifest facts. Never stored. */
export function deriveLane(lane: LaneRecord, now: number): LaneStatus {
	// Precedence mirrors pi: an explicit --thinking beats the model's `:thinking` suffix, which
	// splits only on the last colon and a valid level word (ids like `qwen3-coder:exacto` keep it).
	const pinned = lane.model?.match(/^(.+):(off|minimal|low|medium|high|xhigh|max)$/);
	const base: LaneStatus = {
		name: lane.name,
		state: "failed",
		turns: 0,
		usage: emptyUsage(),
		model: pinned?.[1] ?? lane.model,
		thinkingLevel: lane.thinking ?? pinned?.[2],
		lastEventAgeSec: null,
	};

	if (!lane.spawned) return { ...base, cause: "spawn", spawnError: lane.spawnError };

	const events = parseEvents(lane.eventsPath);
	for (const e of events) {
		if (e.type === "turn_start") base.turns++;
		const message = assistantMessageEnd(e);
		if (message !== null) {
			const u = message.usage ?? {};
			base.usage.input += u.input ?? 0;
			base.usage.output += u.output ?? 0;
			base.usage.cacheRead += u.cacheRead ?? 0;
			base.usage.cacheWrite += u.cacheWrite ?? 0;
			base.usage.cost += u.cost?.total ?? 0;
			if (typeof message.stopReason === "string") base.stopReason = message.stopReason;
			// The last assistant message is authoritative for identity — a message without
			// thinkingLevel (model switch to a non-thinking model) clears a stale level.
			if (typeof message.model === "string") {
				base.model = message.model;
				base.thinkingLevel = typeof message.thinkingLevel === "string" ? message.thinkingLevel : undefined;
			}
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

/** Whether every lane of a wave has reached a terminal state (`settled` or `failed`). */
export function waveTerminal(lanes: LaneRecord[], now: number): boolean {
	return lanes.every((lane) => {
		const state = deriveLane(lane, now).state;
		return state === "settled" || state === "failed";
	});
}

/**
 * Poll a wave until every lane is terminal, `waitMs` elapses, or the signal
 * aborts; returns the final statuses. Re-reads the manifest on every poll —
 * the same derived truth as the status action, held open.
 */
export async function waitForTerminal(
	workDir: string,
	wave: string,
	waitMs: number,
	pollMs: number,
	signal?: AbortSignal,
): Promise<LaneStatus[]> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const lanes = readManifest(workDir, wave).lanes;
		const now = Date.now();
		if (waveTerminal(lanes, now) || now >= deadline || signal?.aborted) {
			return lanes.map((lane) => deriveLane(lane, now));
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

export { parseEvents };
