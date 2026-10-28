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

/** Tool allowlist used when a lane omits `tools` — read-only by design. */
export const DEFAULT_LANE_TOOLS = "read,grep,find,ls";

/**
 * Tools that route a lane to MCP tools whatever the servers' exposure —
 * `mcp__` entries and the resource tools declare tools only under `direct`
 * exposure (pi waits for those), which dispatch cannot know in advance.
 */
const MCP_REACH_TOOLS = ["codemode", "tool_search"];

/** Lane parameters as they arrive from the dispatch tool. */
export type LaneParams = {
	name: string;
	briefPath: string;
	model?: string;
	/** pi's --thinking vocabulary; wins over any `:level` suffix on model. */
	thinking?: string;
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

/** Resolved absolute paths of every lane brief that does not exist as a file. */
export function missingBriefs(lanes: LaneParams[], cwd: string = process.cwd()): string[] {
	const missing: string[] = [];
	for (const lane of lanes) {
		const abs = path.resolve(cwd, lane.briefPath);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) missing.push(abs);
	}
	return missing;
}

/** The dispatch-time refusal: resolved paths plus the parallel-batch remedy (a write batched with dispatch races the check). */
export function missingBriefsError(missing: string[]): string {
	return (
		`brief file(s) not found: ${missing.join(", ")} — nothing spawned. ` +
		"A brief written in the same parallel tool-call batch as this dispatch can still be in flight: " +
		"re-run the same dispatch after the write returns."
	);
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

/** Parse a `tools` string exactly as pi parses `--tools`: split on commas, trim, drop empties. */
export function toolEntries(lane: LaneParams): string[] {
	return (lane.tools ?? DEFAULT_LANE_TOOLS)
		.split(",")
		.map((s) => s.trim())
		.filter((e) => e !== "");
}

/** A fenced bash/shell block in a brief is an instruction to run — bash must be granted. */
const BRIEF_SHELL_FENCE = /^```(bash|sh|shell|zsh)\s*$/m;

/** Whether the brief file carries a fenced shell block (a runnable command, not quoted output). */
export function briefDemandsBash(briefPath: string): boolean {
	return BRIEF_SHELL_FENCE.test(fs.readFileSync(briefPath, "utf8"));
}

/** Whether a `--tools` entry matches a tool name — exact, or a `*` pattern anchored both ends (pi's matcher). */
function entryMatches(entry: string, name: string): boolean {
	if (!entry.includes("*")) return entry === name;
	const source = entry.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
	return new RegExp(`^${source}$`).test(name);
}

/**
 * Validate every lane's `tools` at the tool boundary. An allowlist names plain
 * tools or `*` patterns — `+name`/`-name` lists are not allowlists: pi applies
 * them to its default selection and would silently grant `bash`/`edit`/`write`.
 * A lane that leaves MCP enabled must name `codemode` or `tool_search`, else
 * its connected servers stay unreachable dead weight.
 */
export function assertLaneTools(lanes: LaneParams[]): void {
	const problems: string[] = [];
	for (const lane of lanes) {
		const entries = toolEntries(lane);
		const modifiers = entries.filter((e) => e.startsWith("+") || e.startsWith("-"));
		if (modifiers.length > 0) {
			problems.push(
				`lane '${lane.name}': tools must be a plain allowlist, not +name/-name modifiers (${modifiers.join(", ")}) — ` +
					"modifiers apply to pi's default selection and silently grant bash/edit/write; list every tool instead",
			);
			continue;
		}
		const quoted = entries.filter((e) => e.includes("'") || e.includes('"'));
		if (quoted.length > 0) {
			problems.push(
				`lane '${lane.name}': tools entries must not carry shell quoting (${quoted.join(", ")}) — ` +
					"the allowlist is one argv value and pi takes entries verbatim, so a quoted name matches no tool; write read, not 'read'",
			);
			continue;
		}
		if (entries.length === 0) {
			problems.push(`lane '${lane.name}': tools allowlist is empty — name at least one tool`);
			continue;
		}
		if (lane.mcp === false || lane.noExtensions === true) continue; // MCP never connects
		const hasRoute = entries.some((e) => MCP_REACH_TOOLS.some((t) => entryMatches(e, t)));
		if (!hasRoute) {
			problems.push(
				`lane '${lane.name}': MCP left enabled but tools '${lane.tools ?? DEFAULT_LANE_TOOLS}' grants no route to MCP tools — ` +
					"name 'codemode' or 'tool_search' (an 'mcp__server__*' entry alone reaches only direct-exposure servers; pair it with codemode), " +
					"or set mcp:false — entries reach pi verbatim, no shell quoting",
			);
		}
	}
	if (problems.length > 0) throw new Error(problems.join("\n"));
}

/**
 * Reject lanes whose brief carries a fenced shell block while `bash` is not in
 * their tools: the lane would only discover the missing tool mid-run, after the
 * dispatcher stopped looking. Validate before the manifest claim.
 */
export function assertBriefTools(lanes: LaneParams[], cwd: string = process.cwd()): void {
	const problems: string[] = [];
	for (const lane of lanes) {
		// `*` patterns count — pi's matcher, not a literal scan, decides what a lane can run.
		if (toolEntries(lane).some((e) => entryMatches(e, "bash"))) continue;
		const briefPath = path.resolve(cwd, lane.briefPath);
		if (briefDemandsBash(briefPath)) {
			problems.push(
				`lane '${lane.name}': brief carries a fenced bash/shell block but tools '${lane.tools ?? DEFAULT_LANE_TOOLS}' grants no 'bash' — ` +
					"grant bash in tools or unfence the block (quoted output belongs in a text fence)",
			);
		}
	}
	if (problems.length > 0) throw new Error(problems.join("\n"));
}

/**
 * Build the lane argv: `timeout -k <graceSec> <deadlineSec> pi --mode json
 * --no-session -ns [flags] @<brief>`. The json/no-session/-ns triple is the
 * fixed lane protocol (lanes never load skills); everything variable is a
 * parameter or config knob. `-k` escalates a caught SIGTERM to SIGKILL so a
 * stalled dispose cannot outlive the leash. Omitted `tools` defaults to a
 * read-only allowlist — a lane must be granted `bash`/`edit`/`write` explicitly.
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
		"--tools",
		lane.tools ?? DEFAULT_LANE_TOOLS,
		...(lane.mcp === false ? ["--no-mcp"] : []),
		...(lane.model ? ["--model", lane.model] : []),
		...(lane.thinking ? ["--thinking", lane.thinking] : []),
		`@${path.resolve(lane.briefPath)}`,
	];
}

/**
 * Child env: marks the process as a dispatched lane so this extension's
 * factory stays out of it — a lane never gets the `dispatch` tool again.
 * `-ne` remains the switch that drops all extensions.
 */
export function laneEnv(): NodeJS.ProcessEnv {
	return { ...process.env, PI_MINIMAL_DISPATCH_CHILD: "1" };
}

/** Lanes eligible for a kill signal: spawned, alive by the caller's check, not settled. */
export function selectKillTargets(lanes: LaneRecord[], isAlive: (lane: LaneRecord) => boolean, isSettled: (lane: LaneRecord) => boolean): LaneRecord[] {
	return lanes.filter((lane) => lane.pid !== null && lane.spawned && isAlive(lane) && !isSettled(lane));
}
