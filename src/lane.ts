/**
 * pi-minimal-dispatch lane contract — slug validation, brief validation,
 * executable resolution, spawn argv construction, and kill-target selection.
 * Pure Node builtins: importable and testable without the pi host.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatchConfig } from "./config.ts";
import type { LaneRecord } from "./derive.ts";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Lane parameters as they arrive from the dispatch tool. */
export type LaneParams = {
	name: string;
	briefPath: string;
	model?: string;
	deadlineSec?: number;
	tools?: string;
	noExtensions?: boolean;
	mcp?: boolean;
};

/** Validate wave and lane slugs: kebab-case, max 64 chars, unique within the call. */
export function assertSlugs(wave: string, names: string[]): void {
	const bad: string[] = [];
	if (!SLUG.test(wave)) bad.push(`wave '${wave}'`);
	for (const n of names) if (!SLUG.test(n)) bad.push(`lane '${n}'`);
	const dupes = names.filter((n, i) => names.indexOf(n) !== i);
	for (const d of new Set(dupes)) bad.push(`duplicate lane '${d}'`);
	if (bad.length > 0) throw new Error(`slugs must be kebab-case [a-z0-9-], max 64 chars, unique: ${bad.join(", ")}`);
}

/** Return every brief path that does not resolve to an existing regular file. */
export function missingBriefs(lanes: LaneParams[], cwd: string = process.cwd()): string[] {
	const missing: string[] = [];
	for (const lane of lanes) {
		const abs = path.resolve(cwd, lane.briefPath);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) missing.push(lane.briefPath);
	}
	return missing;
}

/** Resolve an executable on PATH; a directory on PATH is not an executable. */
export function resolveExecutable(name: string): string {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const p = path.join(dir, name);
		try {
			if (!fs.statSync(p).isFile()) continue;
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {
			// keep scanning
		}
	}
	throw new Error(`executable '${name}' not found on PATH`);
}

/**
 * Build the lane argv: `timeout -k <graceSec> <deadlineSec> pi --mode json
 * --no-session -ns [flags] @<brief>`. The json/no-session/-ns triple is the
 * fixed lane protocol (lanes never load skills); everything variable is a
 * parameter or config knob. `-k` escalates a caught SIGTERM to SIGKILL so a
 * stalled dispose cannot outlive the leash.
 */
export function buildLaneArgs(lane: LaneParams, cfg: Pick<DispatchConfig, "piBin">, deadlineSec: number, killGraceSec: number): string[] {
	return [
		"-k",
		String(killGraceSec),
		String(deadlineSec),
		cfg.piBin,
		"--mode",
		"json",
		"--no-session",
		"-ns",
		...(lane.noExtensions ? ["-ne"] : []),
		...(lane.tools ? ["--tools", lane.tools] : []),
		...(lane.mcp === false ? ["--no-mcp"] : []),
		...(lane.model ? ["--model", lane.model] : []),
		`@${path.resolve(lane.briefPath)}`,
	];
}

/** Lanes eligible for a kill signal: spawned, alive by the caller's check, not settled. */
export function selectKillTargets(lanes: LaneRecord[], isAlive: (lane: LaneRecord) => boolean, isSettled: (lane: LaneRecord) => boolean): LaneRecord[] {
	return lanes.filter((lane) => lane.pid !== null && lane.spawned && isAlive(lane) && !isSettled(lane));
}
