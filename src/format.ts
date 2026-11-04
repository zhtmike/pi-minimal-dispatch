/**
 * pi-minimal-dispatch presentation — human-facing text for lane status,
 * shared by the `lanes` tool, the `/lanes` command, and the statusbar.
 */

import { type LaneStatus, type TraceSummary, type WaveScan } from "./derive.ts";
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

/** Cut at the last complete character within `maxBytes` — never a split multibyte character. */
function cutToByteBoundary(content: string, maxBytes: number): { text: string; totalBytes: number; truncated: boolean } {
	const buf = Buffer.from(content, "utf8");
	if (buf.length <= maxBytes) return { text: content, totalBytes: buf.length, truncated: false };
	let cut = maxBytes;
	while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--; // back to a character boundary
	return { text: buf.subarray(0, cut).toString("utf8"), totalBytes: buf.length, truncated: true };
}

/**
 * Fenced artifact body for inlining: the fence is one backtick longer than the
 * displayed content's longest fence run (a fixed fence would terminate early);
 * over-budget content truncates at its last complete character within the
 * first N bytes — never a split multibyte character.
 */
export function formatInlineArtifact(content: string, artifactPath: string, maxBytes: number): string {
	const { text: body, totalBytes, truncated } = cutToByteBoundary(content, maxBytes);
	const marker = truncated
		? `${body.endsWith("\n") ? "" : "\n"}… [truncated, total ${totalBytes} bytes — read ${artifactPath} for the rest]`
		: "";
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

/** One bracketed line appended to dispatch output: the blocking call that replaces status polling. */
export function dispatchNextHint(wave: string): string {
	return (
		`[next: lanes(wave='${wave}', action='wait') — blocks until every lane settles or fails; ` +
		"waitSec caps the hold; action='status' to peek]"
	);
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

/** `/lanes` wave view's lane lines: the LLM lines unchanged, plus linked files for failed lanes (the wave header carries the caption). */
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
	return lines.join("\n");
}

// --- /lanes inspector -------------------------------------------------------

/** Fixed truncation for one-line trace snippets (tool args, text previews). */
export const TRACE_SNIPPET_CHARS = 80;

/** Single-lined, length-capped rendering of a trace value — args or text preview. */
export function snippet(value: unknown): string {
	const s = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > TRACE_SNIPPET_CHARS ? `${one.slice(0, TRACE_SNIPPET_CHARS)}…` : one;
}

/** Human wall-clock span: 45s · 12m30s · 1h05m. */
export function formatDuration(totalSec: number): string {
	const s = Math.max(0, Math.round(totalSec));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Tool-call duration: 840ms · 8.4s · 1m02s — sub-second precision kept. */
export function formatMillis(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return formatDuration(ms / 1000);
}

/** The one-line grammar hint shared by the listing and unknown-wave errors. */
export function lanesUsageLine(): string {
	return "usage: /lanes [wave] [lane] — list waves · inspect one wave · inspect one lane";
}

/** `/lanes` no-args listing: one line per scanned wave, corrupt manifests included. */
export function formatWaveList(scans: WaveScan[]): string {
	const lines = scans.map((sc) => {
		if (!sc.ok) return `  ${sc.wave} — manifest error: ${sc.error}`;
		const prior = sc.priorSession ? " (prior session)" : "";
		const counts: Record<string, number> = {};
		for (const s of sc.statuses) counts[s.state] = (counts[s.state] ?? 0) + 1;
		const states = ["running", "starting", "failed", "settled"]
			.filter((k) => counts[k] > 0)
			.map((k) => `${counts[k]} ${k}`)
			.join(" · ");
		return `  ${sc.wave}${prior} — ${sc.statuses.length} lane${sc.statuses.length === 1 ? "" : "s"} · ${states}`;
	});
	const body = lines.length > 0 ? lines.join("\n") : "  no waves found";
	return `waves:\n${body}\n${lanesUsageLine()}`;
}

/** Wave-level header for `/lanes <wave>`: wall clock since dispatch + pure usage sums. */
export function formatWaveHeader(wave: string, createdAt: string, statuses: LaneStatus[], now: number): string {
	const usage = statuses.reduce(
		(a, s) => ({ input: a.input + s.usage.input, output: a.output + s.usage.output, cost: a.cost + s.usage.cost }),
		{ input: 0, output: 0, cost: 0 },
	);
	const dur = formatDuration((now - Date.parse(createdAt)) / 1000);
	return `wave '${wave}' — ${dur} since dispatch · ${statuses.length} lanes · tok ${usage.input}in/${usage.output}out · $${usage.cost.toFixed(4)}`;
}

/** Everything the single-lane inspector needs; the glue reads files, this renders. */
export type InspectorInput = {
	wave: string;
	status: LaneStatus;
	trace: TraceSummary;
	eventsPath: string;
	errPath: string;
	/** Present when the collect artifact exists — content read by the glue. */
	artifact?: { path: string; content: string };
};

/** `/lanes <wave> <lane>`: single-lane view shaped by the lane's state. */
export function formatLaneInspector(l: InspectorInput, renderPath: PathRenderer): string {
	const s = l.status;
	const id = [s.model, s.thinkingLevel !== undefined ? `think:${s.thinkingLevel}` : undefined].filter(Boolean).join(" ");
	const head = [`lane '${s.name}' in wave '${l.wave}' — ${s.state}${s.cause !== undefined ? ` (${s.cause})` : ""}`];
	const bits: string[] = [];
	if (id !== "") bits.push(id);
	if (s.state !== "starting") bits.push(s.turns === 1 ? "1 turn" : `${s.turns} turns`);
	if (s.state === "settled" || s.state === "failed") bits.push(`tok ${s.usage.input}in/${s.usage.output}out · $${s.usage.cost.toFixed(4)}`);
	if (s.stopReason !== undefined) bits.push(`stop:${s.stopReason}`);
	if (s.lastEventAgeSec !== null) bits.push(`last ${s.lastEventAgeSec}s ago`);
	if (bits.length > 0) head.push(`  ${bits.join(" · ")}`);
	if (s.spawnError !== undefined) head.push(`  spawn error: ${s.spawnError}`);

	const out = [...head];
	if (s.errTail !== undefined) out.push(`  err: ${s.errTail.replace(/\n/g, "\n    ")}`);
	if (l.trace.tools.length > 0) {
		out.push("  trace:");
		for (const t of l.trace.tools) {
			const tail = t.inflight === true ? "in flight" : t.durationMs !== undefined ? formatMillis(t.durationMs) : "closed";
			out.push(`    ${t.name} ${snippet(t.args)} — ${tail}`);
		}
	}
	if (s.state === "settled") {
		if (l.artifact !== undefined) {
			const bytes = Buffer.byteLength(l.artifact.content, "utf8");
			out.push(`  artifact: ${renderPath(l.artifact.path)} (${bytes} B)`);
			out.push(l.artifact.content.replace(/\n$/, "").split("\n").map((line) => `    ${line}`).join("\n"));
		} else {
			if (l.trace.lastText !== "") out.push(`  last text: ${snippet(l.trace.lastText)}`);
			out.push("  artifact: not yet collected");
		}
	} else if (l.trace.lastText !== "") {
		out.push(`  last text: ${snippet(l.trace.lastText)}`);
	}
	if (s.state === "failed") out.push(`  transcript: ${renderPath(l.eventsPath)} · err: ${renderPath(l.errPath)}`);
	return out.join("\n");
}

// --- expandable collect blocks (TUI details channel) --------------------------

/** Per-lane artifact snapshot cap — fixed, not configurable (the channel is human-only). */
export const COLLECT_SNAPSHOT_MAX_BYTES = 16 * 1024;

/** One lane's execute-time artifact snapshot — the expanded block renders this, never disk. */
export type CollectSnapshotEntry = {
	name: string;
	/** Absolute artifact path — the expanded header's reference once the artifact may be gone. */
	artifact: string;
	/** Artifact bytes at collect time, capped at COLLECT_SNAPSHOT_MAX_BYTES. */
	content: string;
	truncated: boolean;
};

/** Build one lane's snapshot: the byte cap cuts at the last complete character. */
export function collectSnapshotEntry(name: string, artifact: string, content: string): CollectSnapshotEntry {
	const { text, truncated } = cutToByteBoundary(content, COLLECT_SNAPSHOT_MAX_BYTES);
	return { name, artifact, content: text, truncated };
}

/**
 * Markdown source for the expanded collect block: one header per collected lane,
 * its snapshot below. The renderer markdown-renders this; the snapshot (not a disk
 * read) is what keeps the block honest after release deletes the artifact.
 */
export function formatCollectExpanded(snapshot: CollectSnapshotEntry[]): string {
	if (snapshot.length === 0) return "_nothing collected — every lane was refused_";
	return snapshot
		.map((e) => `**${e.name}** — ${e.artifact}${e.truncated ? ` *(truncated at ${COLLECT_SNAPSHOT_MAX_BYTES / 1024} kB)*` : ""}\n\n${e.content.replace(/\n$/, "")}`)
		.join("\n\n");
}
