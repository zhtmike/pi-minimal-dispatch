/**
 * pi-minimal-dispatch presentation — human-facing text for lane status,
 * shared by the `lanes` tool, the `/lanes` command, and the statusbar.
 */

import { type LaneStatus } from "./derive.ts";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Suspect flag with its first-applicable cause: `failed:<cause>` (killed/
 * deadline/crashed — spawn-failed lanes are refused before this), `empty`
 * (no final assistant text), `stop:<stopReason>` (terminal message stop
 * reason ≠ `stop`). The cause is informational rendering; the boolean is
 * the stable flag.
 */
export function suspectOf(status: Pick<LaneStatus, "state" | "cause" | "stopReason">, finalText: string): { suspect: boolean; cause?: string } {
	if (status.state === "failed") return { suspect: true, cause: `failed:${status.cause}` };
	if (finalText === "") return { suspect: true, cause: "empty" };
	if (status.stopReason !== "stop") return { suspect: true, cause: `stop:${status.stopReason}` };
	return { suspect: false };
}

/** One collect line plus its optional inline artifact block. */
export type CollectEntry = {
	name: string;
	artifact?: string;
	reason?: string;
	suspect?: boolean;
	suspectCause?: string;
	stopReason?: string;
	/** Artifact content exactly as written to disk; present only for collected lanes. */
	content?: string;
};

/**
 * A suspect lane never inlines: its artifact is not done, and inlining would
 * paste it into the dispatcher's context by default.
 */
export function formatCollectEntry(entry: CollectEntry, inlineMaxBytes: number): string {
	const line =
		`  ${entry.name}: ${entry.artifact ?? entry.reason}` +
		`${entry.suspect ? ` [SUSPECT${entry.suspectCause !== undefined ? `: ${entry.suspectCause}` : ""}]` : ""}` +
		`${entry.stopReason !== undefined ? ` stop:${entry.stopReason}` : ""}`;
	if (inlineMaxBytes <= 0 || entry.suspect || entry.artifact === undefined || entry.content === undefined) return line;
	return `${line}\n${formatInlineArtifact(entry.content, entry.artifact, inlineMaxBytes)}`;
}

/**
 * Fenced artifact body for inlining: the fence is one backtick longer than the
 * displayed content's longest fence run (a fixed fence would terminate early);
 * over-budget content truncates at its last complete character within the
 * first N bytes — never a split multibyte character.
 */
export function formatInlineArtifact(content: string, artifactPath: string, maxBytes: number): string {
	const buf = Buffer.from(content, "utf8");
	let body = content;
	let marker = "";
	if (buf.length > maxBytes) {
		let cut = maxBytes;
		while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // back to a character boundary
		body = buf.subarray(0, cut).toString("utf8");
		marker = `${body.endsWith("\n") ? "" : "\n"}… [truncated, total ${buf.length} bytes — read ${artifactPath} for the rest]`;
	}
	// matchAll, not a spread of matches: a backtick-dense artifact overflows the spread at ~10^5 runs
	let longest = 0;
	for (const run of body.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	const payload = body + marker;
	return `${fence}\n${payload}${payload.endsWith("\n") ? "" : "\n"}${fence}`;
}

/** One status-table line per lane (two-space indent, err tail four-space indented). */
export function formatLaneLine(s: LaneStatus): string {
	// Short form: provider prefix dropped, thinking level labeled `think:` (a bare level word
	// reads like a model variant) — the full ids live in the structured status payload.
	// No model yet (pre-generation, no pins): [default] — omitted pins inherit pi's
	// configured default; an absent tag reads as "no model / broken".
	const id = s.model ? s.model.split("/").pop() : "default";
	const tag = ` [${id}${s.thinkingLevel !== undefined ? ` think:${s.thinkingLevel}` : ""}]`;
	const bits = [`${s.name}${tag}`, s.state];
	if (s.cause) bits.push(`(${s.cause}${s.spawnError ? `: ${s.spawnError}` : ""})`);
	if (s.overdue) bits.push("OVERDUE");
	bits.push(s.turns === 1 ? "1 turn" : `${s.turns} turns`);
	bits.push(`tok ${s.usage.input}in/${s.usage.output}out, $${s.usage.cost.toFixed(4)}`);
	if (s.stopReason !== undefined) bits.push(`stop:${s.stopReason}`);
	if (s.lastEventAgeSec !== null) bits.push(`last ${s.lastEventAgeSec}s ago`);
	return `  ${bits.join(" · ")}` + (s.errTail ? `\n    err: ${s.errTail.replace(/\n/g, "\n    ")}` : "");
}

/** Full status table for one wave. */
export function formatWaveStatus(wave: string, statuses: LaneStatus[]): string {
	return `wave '${wave}':\n${statuses.map(formatLaneLine).join("\n")}`;
}

// --- statusbar footer -------------------------------------------------------

/** Footer entry: a lane status tagged with its wave — the tick knows the manifest. */
export type StatusBarEntry = LaneStatus & { wave?: string };

/** A lane this stale without a word is the straggler signal — fixed, not configurable. */
export const IDLE_AFTER_SEC = 60;

/** Footer summary across tracked waves; undefined when nothing to watch — clear the status entry. */
export function formatStatusBarSummary(statuses: StatusBarEntry[]): string | undefined {
	if (statuses.length === 0) return undefined;
	const inflight = statuses.filter((s) => s.state === "running" || s.state === "starting");
	const failed = statuses.filter((s) => s.state === "failed");
	const settled = statuses.filter((s) => s.state === "settled");
	// In-flight lanes or an unreleased failure keep the footer (and its poll tick) alive;
	// a fully settled wave clears it — collect is the next step and the tool results carry it.
	if (inflight.length === 0 && failed.length === 0) return undefined;

	const parts: string[] = [];
	// [telemetry | running-count] — telemetry only for a lone running lane the tick can name
	const lone = inflight.length === 1 && inflight[0].state === "running" && inflight[0].wave !== undefined ? inflight[0] : undefined;
	if (lone !== undefined) {
		const bits = [`turn ${lone.turns}`];
		if (lone.inflightTool !== undefined) bits.push(lone.inflightTool);
		if (lone.lastEventAgeSec !== null) bits.push(`last ${Math.round(lone.lastEventAgeSec)}s`);
		parts.push(`lanes [${lone.wave}/${lone.name}]: running (${bits.join(" · ")})`);
	} else if (inflight.length > 0) {
		parts.push(`${inflight.length} running`);
	}

	// [idle/overdue badge] — the age is the honest last-event age; overdue needs no age
	const idle = inflight.filter((s) => s.state === "running" && !s.overdue && s.lastEventAgeSec !== null && s.lastEventAgeSec >= IDLE_AFTER_SEC);
	const overdue = inflight.filter((s) => s.state === "running" && s.overdue);
	const badges: string[] = [];
	if (idle.length > 0) badges.push(`${idle.length} idle ${Math.round(Math.max(...idle.map((s) => s.lastEventAgeSec ?? 0)))}s`);
	if (overdue.length > 0) badges.push(`${overdue.length} overdue`);
	if (badges.length > 0) parts.push(`(${badges.join(" · ")})`);

	// [failed badge] · [settled/failed counts] — the failed bucket carries the first cause
	if (failed.length > 0) parts.push(`${failed.length} failed${failed[0].cause !== undefined ? ` (${failed[0].cause})` : ""}`);
	if (settled.length > 0) parts.push(`${settled.length} settled`);

	return `${lone !== undefined ? "" : "lanes: "}${parts.join(" · ")}`;
}

// --- TUI path display -------------------------------------------------------

/** Link display text: `./`-relative under the cwd, absolute outside it — TUI surfaces only. */
export function displayPath(p: string, cwd: string): string {
	const rel = path.relative(cwd, p);
	return rel !== "" && !rel.startsWith(`..${path.sep}`) && rel !== ".." ? `.${path.sep}${rel}` : p;
}

/** Plain fallback (links off): absolute or `~`-collapsed — a bare `./rel` would be unanchored. */
export function plainPath(p: string, home: string): string {
	return p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** OSC 8 target for a path — pi core's own `linkPath` form (`pathToFileURL`). */
export function fileUri(p: string): string {
	return pathToFileURL(p).href;
}

/** Path → rendered string for a TUI surface; the glue injects the real (gated) hyperlink. */
export type PathRenderer = (absolutePath: string) => string;

/** `/lanes`-only table: the LLM lines unchanged, plus linked files for failed lanes. */
export function formatWaveStatusTui(
	wave: string,
	lanes: Array<{ status: LaneStatus; eventsPath: string; errPath: string }>,
	renderPath: PathRenderer,
): string {
	const lines = lanes.map(({ status: s, eventsPath, errPath }) => {
		const base = formatLaneLine(s);
		if (s.state !== "failed") return base;
		return `${base}\n    files: ${renderPath(eventsPath)} · ${renderPath(errPath)}`;
	});
	return `wave '${wave}':\n${lines.join("\n")}`;
}
