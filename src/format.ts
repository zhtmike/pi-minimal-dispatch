/**
 * pi-minimal-dispatch presentation — human-facing text for lane status,
 * shared by the `lanes` tool, the `/lanes` command, and the statusbar.
 */

import type { LaneStatus } from "./derive.ts";

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
