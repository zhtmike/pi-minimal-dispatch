/**
 * Unit tests for src/lane.ts — slug validation, brief validation, executable
 * resolution, argv construction, kill-target selection.
 * Run: node tests/lane.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertActionParams,
	assertBriefTools,
	assertLaneTools,
	assertSlugs,
	buildLaneArgs,
	DEFAULT_LANE_TOOLS,
	laneEnv,
	lanesCompletions,
	missingBriefs,
	missingBriefsError,
	parseLanesArgs,
	resolveExecutable,
	resolveLaneFilter,
	selectKillTargets,
	toolEntries,
} from "../src/lane.ts";
import type { LaneParams } from "../src/lane.ts";
import type { LaneRecord } from "../src/derive.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}
function throwsWith(fn: () => unknown, needle: string): boolean {
	try {
		fn();
		return false;
	} catch (e: any) {
		return e.message.includes(needle);
	}
}

// --- assertSlugs -----------------------------------------------------------

check("slugs: valid wave + names pass", (() => { assertSlugs("wave-1", ["docs", "review-2"]); return true; })());
check("slugs: malformed listed per violation", throwsWith(() => assertSlugs("Bad_Slug", ["UP", "UP"]), "wave 'Bad_Slug'")
	&& throwsWith(() => assertSlugs("ok", ["UP", "UP"]), "duplicate lane 'UP'")
	&& throwsWith(() => assertSlugs("ok", ["a".repeat(65)]), "lane 'aaaa"));
check("slugs: duplicates reported even when well-formed", throwsWith(() => assertSlugs("w", ["lane", "lane"]), "duplicate lane 'lane'"));

// --- missingBriefs ----------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-dispatch-lane-"));
fs.writeFileSync(path.join(tmp, "exists.md"), "brief");
const briefs = [
	{ name: "a", briefPath: path.join(tmp, "exists.md") },
	{ name: "b", briefPath: path.join(tmp, "gone.md") },
	{ name: "c", briefPath: path.join(tmp, "also-gone.md") },
];
check("briefs: every missing path listed, existing kept", (() => {
	const missing = missingBriefs(briefs);
	return missing.length === 2 && missing.includes(briefs[1].briefPath) && missing.includes(briefs[2].briefPath);
})());
check("briefs: a directory is not a brief", missingBriefs([{ name: "d", briefPath: tmp }]).length === 1);
check(
	"briefs: missing paths are resolved absolute (what the refusal names)",
	missingBriefs([{ name: "r", briefPath: "relative-gone.md" }], tmp)[0] === path.join(tmp, "relative-gone.md"),
);
const refusal = missingBriefsError(["/x/gone.md"]);
check(
	"briefs: refusal names paths and the parallel-batch remedy",
	refusal.includes("/x/gone.md") && refusal.includes("nothing spawned") && refusal.includes("parallel tool-call batch") && refusal.includes("re-run the same dispatch"),
	refusal,
);

// --- resolveExecutable ------------------------------------------------------

const bin = path.join(tmp, "bin");
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, "good-bin"), "#!/bin/sh\nexit 0\n");
fs.chmodSync(path.join(bin, "good-bin"), 0o755);
fs.mkdirSync(path.join(bin, "dir-bin"), { recursive: true }); // X_OK passes on dirs — must be rejected
fs.writeFileSync(path.join(bin, "noexec-bin"), "#!/bin/sh\nexit 0\n"); // no +x
const prevPath = process.env.PATH;
process.env.PATH = bin;
check("executable: found and executable", resolveExecutable("good-bin").endsWith("good-bin"));
check("executable: a directory on PATH is not an executable", throwsWith(() => resolveExecutable("dir-bin"), "not found"));
check("executable: non-executable file is not found", throwsWith(() => resolveExecutable("noexec-bin"), "not found"));
check("executable: absent name errors naming it", throwsWith(() => resolveExecutable("definitely-absent"), "'definitely-absent'"));
if (prevPath === undefined) delete process.env.PATH;
else process.env.PATH = prevPath;

// --- buildLaneArgs ----------------------------------------------------------

const cfg = { piBin: "pi" };
const lane = { name: "x", briefPath: "b.md", model: "m1", thinking: "high", deadlineSec: 42, tools: "read,bash", noExtensions: true, mcp: false };
const args = buildLaneArgs(lane, cfg, 42, 5);
check(
	"argv: -k grace, deadline, fixed protocol, flags, resolved brief",
	args[0] === "-k" && args[1] === "5" && args[2] === "42" && args[3] === "pi" &&
		args.slice(4, 8).join(" ") === "--mode json --no-session -ns" &&
		args.includes("-ne") && args.includes("--tools") && args[args.indexOf("--tools") + 1] === "read,bash" &&
		args.includes("--no-mcp") && args.includes("--model") && args[args.indexOf("--model") + 1] === "m1" &&
		args.includes("--thinking") && args[args.indexOf("--thinking") + 1] === "high" &&
		args[args.length - 1] === `@${path.resolve("b.md")}`,
	JSON.stringify(args),
);
const bare = buildLaneArgs({ name: "x", briefPath: "b.md" }, cfg, 900, 5);
check(
	"argv: omitted tools defaults to the read-only allowlist",
	bare[bare.indexOf("--tools") + 1] === "read,grep,find,ls" && bare.length === 11,
	JSON.stringify(bare),
);
const both = buildLaneArgs({ name: "x", briefPath: "b.md", model: "m1:low", thinking: "high" }, cfg, 900, 5);
check(
	"argv: thinking passes through beside a `:level` model suffix (pi resolves precedence)",
	both[both.indexOf("--model") + 1] === "m1:low" && both[both.indexOf("--thinking") + 1] === "high",
	JSON.stringify(both),
);
check(
	"child env: carries the lane marker over the parent env",
	(() => {
		process.env.TEST_MARKER = "present";
		const env = laneEnv();
		const ok = env.PI_MINIMAL_DISPATCH_CHILD === "1" && env.TEST_MARKER === "present";
		delete process.env.TEST_MARKER;
		return ok;
	})(),
);

// --- assertLaneTools -------------------------------------------------------

const L = (name: string, over: Partial<LaneParams> = {}): LaneParams => ({ name, briefPath: "b.md", ...over });

check("lane tools: default is the read-only allowlist", DEFAULT_LANE_TOOLS === "read,grep,find,ls");
check(
	"lane tools: parsing mirrors pi (split commas, trim, drop empties)",
	(() => {
		const a = toolEntries(L("x", { tools: "read, bash ,mcp__web__*" }));
		const b = toolEntries(L("x", { tools: " , " }));
		return a.join("|") === "read|bash|mcp__web__*" && b.length === 0;
	})(),
);
check(
	"lane tools: default lane (no tools, mcp on) is rejected as blind",
	throwsWith(() => assertLaneTools([L("web")]), "lane 'web'") && throwsWith(() => assertLaneTools([L("web")]), "no route to MCP tools"),
);
check(
	"lane tools: rejection names both remedies",
	throwsWith(() => assertLaneTools([L("web")]), "codemode") && throwsWith(() => assertLaneTools([L("web")]), "mcp:false"),
);
check("lane tools: mcp:false default tools pass", (() => { assertLaneTools([L("a", { mcp: false }), L("b", { tools: "read,bash", mcp: false })]); return true; })());
check("lane tools: noExtensions:true skips the reach check", (() => { assertLaneTools([L("a", { noExtensions: true })]); return true; })());
check(
	"lane tools: every exposure-independent reach route passes with mcp enabled",
	(() => {
		for (const tools of [
			"read,grep,find,ls,codemode",
			"read,tool_search",
			"read,grep,find,ls,codemode,mcp__websearch__*", // entry scopes a direct-exposure server
			"read,*", // catch-all pattern names codemode too
			"read, codemode", // trimmed like pi
		]) {
			assertLaneTools([L("x", { tools })]);
		}
		return true;
	})(),
);
check(
	"lane tools: mcp__ entries alone are not a route (exposure-dependent)",
	throwsWith(() => assertLaneTools([L("web", { tools: "read,grep,find,ls,mcp__websearch__*" })]), "direct-exposure") &&
		throwsWith(() => assertLaneTools([L("web", { tools: "read,mcp__websearch__web_search" })]), "no route to MCP tools") &&
		throwsWith(() => assertLaneTools([L("web", { tools: "read,mcp*" })]), "no route to MCP tools") &&
		throwsWith(() => assertLaneTools([L("web", { tools: "read,read_mcp_resource" })]), "no route to MCP tools"),
);
check(
	"lane tools: shell-quoted entries are rejected even offline",
	throwsWith(() => assertLaneTools([L("x", { tools: "'read','bash'", mcp: false })]), "shell quoting") &&
		throwsWith(() => assertLaneTools([L("web", { tools: "read,grep,find,ls,'mcp__websearch__*'" })]), "shell quoting"),
);
check(
	"lane tools: +name/-name modifiers are rejected as silent widening",
	throwsWith(() => assertLaneTools([L("x", { tools: "+codemode" })]), "+name/-name modifiers") &&
		throwsWith(() => assertLaneTools([L("x", { tools: "+codemode" })]), "bash/edit/write") &&
		throwsWith(() => assertLaneTools([L("x", { tools: "read,-write", mcp: false })]), "+name/-name modifiers"),
);
check(
	"lane tools: empty allowlist is rejected",
	throwsWith(() => assertLaneTools([L("x", { tools: "" })]), "empty") && throwsWith(() => assertLaneTools([L("x", { tools: " , " })]), "empty"),
);
check(
	"lane tools: every offending lane is listed in one error",
	throwsWith(() => assertLaneTools([L("a", { mcp: false }), L("b"), L("c")]), "lane 'b'") &&
		throwsWith(() => assertLaneTools([L("a", { mcp: false }), L("b"), L("c")]), "lane 'c'"),
);

// --- selectKillTargets ------------------------------------------------------

function fakeLane(over: Partial<LaneRecord>): LaneRecord {
	return { name: "l", briefPath: "/dev/null", eventsPath: "/dev/null", errPath: "/dev/null", pid: 1, processStart: "s", startedAt: new Date().toISOString(), deadlineSec: 900, spawned: true, ...over };
}
const lanes = [
	fakeLane({ name: "killme", pid: 11 }),
	fakeLane({ name: "wrong-start", pid: 12, processStart: "other" }), // reused PID — must be skipped
	fakeLane({ name: "settled", pid: 13 }),
	fakeLane({ name: "never-spawned", pid: null, spawned: false }),
];
const targets = selectKillTargets(lanes, (l) => pidAliveFake(l), (l) => l.name === "settled");
function pidAliveFake(l: LaneRecord): boolean {
	return l.processStart === "s" && l.pid !== null;
}
check("kill targets: only spawned, start-matching, unsettled lanes", targets.length === 1 && targets[0].name === "killme");
check(
	"kill targets: a tombstoned-but-alive lane stays eligible (asking again re-signals it)",
	selectKillTargets([...lanes, fakeLane({ name: "tombstoned-alive", pid: 14, killedAt: new Date().toISOString() })], (l) => pidAliveFake(l), (l) => l.name === "settled").some((l) => l.name === "tombstoned-alive"),
);
check(
	"kill targets: filter intersects eligibility (untargeted lanes never selected)",
	(() => {
		const t = selectKillTargets(lanes, (l) => pidAliveFake(l), (l) => l.name === "settled", new Set(["wrong-start", "settled"]));
		return t.length === 0; // wrong-start fails liveness, settled is excluded — nothing eligible in the filter
	})(),
);
check(
	"kill targets: filter naming an eligible lane selects exactly it",
	selectKillTargets(lanes, (l) => pidAliveFake(l), (l) => l.name === "settled", new Set(["killme", "never-spawned"])).length === 1,
);

// --- assertActionParams ----------------------------------------------------

check(
	"action params: lane accepted by kill and collect, rejected elsewhere naming both",
	(() => {
		assertActionParams("kill", { lane: ["a"] });
		assertActionParams("collect", { lane: "a" });
		return (
			throwsWith(() => assertActionParams("status", { lane: ["a"] }), "applies only to: kill, collect") &&
			throwsWith(() => assertActionParams("wait", { lane: ["a"] }), "'lane'") &&
			throwsWith(() => assertActionParams("release", { lane: ["a"] }), "'release'")
		);
	})(),
);
check(
	"action params: waitMode accepted by wait only; the error names wait",
	(() => {
		assertActionParams("wait", { waitMode: "any" });
		assertActionParams("status", {});
		return (
			throwsWith(() => assertActionParams("status", { waitMode: "any" }), "applies only to: wait") &&
			throwsWith(() => assertActionParams("kill", { waitMode: "all" }), "'kill'") &&
			throwsWith(() => assertActionParams("collect", { waitMode: "any" }), "'waitMode'")
		);
	})(),
);
check(
	"action params: kill with both lane and waitMode reports waitMode (one problem at a time)",
	throwsWith(() => assertActionParams("kill", { lane: ["a"], waitMode: "any" }), "applies only to: wait"),
);
check(
	"action params: waitMode value itself is validated on wait",
	throwsWith(() => assertActionParams("wait", { waitMode: "bogus" }), `waitMode must be "all" or "any"`),
);
check(
	"action params: inlineMaxBytes accepted by collect only, rejected elsewhere naming collect",
	(() => {
		assertActionParams("collect", { inlineMaxBytes: 512 });
		assertActionParams("collect", { inlineMaxBytes: 0 });
		return throwsWith(() => assertActionParams("status", { inlineMaxBytes: 512 }), "applies only to: collect");
	})(),
);
check(
	"action params: inlineMaxBytes rejects negative and non-integer values",
	throwsWith(() => assertActionParams("collect", { inlineMaxBytes: -1 }), "integer >= 0") &&
		throwsWith(() => assertActionParams("collect", { inlineMaxBytes: 1.5 }), "integer >= 0") &&
		throwsWith(() => assertActionParams("collect", { inlineMaxBytes: "512" }), "integer >= 0"),
);

// --- resolveLaneFilter ------------------------------------------------------

const fl = ["alpha", "beta", "gamma"].map((name) => fakeLane({ name }));
check(
	"lane filter: undefined means no filter (whole wave)",
	resolveLaneFilter(fl, undefined) === undefined,
);
check(
	"lane filter: subset in manifest order, same records",
	(() => {
		const sub = resolveLaneFilter(fl, ["gamma", "alpha"])!;
		return sub.length === 2 && sub[0] === fl[0] && sub[1] === fl[2];
	})(),
);
check(
	"lane filter: a bare string is wrapped (model-shape coercion)",
	(() => {
		const sub = resolveLaneFilter(fl, "beta")!;
		return sub.length === 1 && sub[0] === fl[1];
	})(),
);
check("lane filter: duplicates name a lane once", resolveLaneFilter(fl, ["beta", "beta"])!.length === 1);
check(
	"lane filter: unknown slug error lists the wave's valid lanes",
	throwsWith(() => resolveLaneFilter(fl, ["alpha", "nope"]), "unknown lane 'nope'") &&
		throwsWith(() => resolveLaneFilter(fl, ["alpha", "nope"]), "valid lanes: alpha, beta, gamma"),
);
check(
	"lane filter: a bare unknown string lists valid lanes too",
	throwsWith(() => resolveLaneFilter(fl, "nope"), "valid lanes: alpha, beta, gamma"),
);
check("lane filter: empty array is rejected, never a silent no-op", throwsWith(() => resolveLaneFilter(fl, []), "at least one lane"));
check(
	"lane filter: non-array shapes are boundary errors, not raw TypeErrors",
	throwsWith(() => resolveLaneFilter(fl, null as unknown as string[]), "must be a lane name or an array") &&
		throwsWith(() => resolveLaneFilter(fl, { name: "alpha" } as unknown as string[]), "must be a lane name or an array") &&
		throwsWith(() => resolveLaneFilter(fl, ["alpha", 5] as unknown as string[]), "must be a lane name or an array"),
);

// --- assertBriefTools ------------------------------------------------------

const bashBrief = path.join(tmp, "bash-brief.md");
fs.writeFileSync(bashBrief, "Run the checks:\n\n```bash\nnpm test\n```\n");
const textBrief = path.join(tmp, "text-brief.md");
fs.writeFileSync(textBrief, "Observed output:\n\n```text\n$ npm test\nall passed\n```\n");
const shBrief = path.join(tmp, "sh-brief.md");
fs.writeFileSync(shBrief, "```sh\nps -o lstart= -p 1\n```\n");

function BL(over: Partial<LaneParams>): LaneParams {
	return { name: "bl", briefPath: bashBrief, mcp: false, ...over };
}
check(
	"brief tools: fenced bash block without bash in tools is rejected",
	throwsWith(() => assertBriefTools([BL({})]), "grants no 'bash'"),
);
check(
	"brief tools: default tools (no bash) rejected on a fenced block too",
	throwsWith(() => assertBriefTools([{ name: "bl", briefPath: bashBrief }]), "read,grep,find,ls"),
);
check(
	"brief tools: bash granted passes the fenced block",
assertBriefTools([BL({ tools: "read,grep,find,ls,bash" })]) === undefined,
);
check(
	"brief tools: text-fenced output never demands bash",
assertBriefTools([{ name: "bl", briefPath: textBrief, mcp: false }]) === undefined,
);
check(
	"brief tools: sh fence rejected like bash",
	throwsWith(() => assertBriefTools([{ name: "bl", briefPath: shBrief, mcp: false }]), "fenced bash/shell"),
);
check(
	"brief tools: every offending lane is listed",
	throwsWith(() => assertBriefTools([BL({}), BL({ name: "bl2" })]), "lane 'bl2'"),
);
const inlineBrief = path.join(tmp, "inline-brief.md");
fs.writeFileSync(inlineBrief, "Judge, never run: the payload says `git worktree add -b` and `ps -o lstart= -p 1`.\n");
const infoBrief = path.join(tmp, "info-brief.md");
fs.writeFileSync(infoBrief, "```bash title=example\ngit status\n```\n");
const prefixBrief = path.join(tmp, "prefix-brief.md");
fs.writeFileSync(prefixBrief, "```bashscript\nnot a shell fence\n```\n");
check(
	"brief tools: inline backticks, info-string fences, and prefix lookalikes never demand bash",
	assertBriefTools([{ name: "i", briefPath: inlineBrief, mcp: false }, { name: "n", briefPath: infoBrief, mcp: false }, { name: "p", briefPath: prefixBrief, mcp: false }]) === undefined,
);
check(
	"brief tools: a wildcard tools entry granting bash passes a fenced block",
	assertBriefTools([BL({ tools: "read,*" })]) === undefined,
);

fs.rmSync(tmp, { recursive: true, force: true });

// --- /lanes parsing + two-level completion -----------------------------------

check(
	"parseLanesArgs: empty, wave only, wave+lane; extra whitespace collapses",
	(() => {
		const e = parseLanesArgs("");
		const w = parseLanesArgs("  survey  ");
		const wl = parseLanesArgs(" survey docs ");
		return e.wave === undefined && e.lane === undefined && w.wave === "survey" && w.lane === undefined && wl.wave === "survey" && wl.lane === "docs";
	})(),
);
check(
	"parseLanesArgs: three arguments fail loudly",
	(() => {
		try {
			parseLanesArgs("a b c");
			return false;
		} catch (e: any) {
			return e.message.includes("at most two arguments");
		}
	})(),
);
check(
	"completions level 1: wave slugs filtered, deduped, sorted",
	(() => {
		const out = lanesCompletions("al", ["beta", "alpha", "alpha"], () => []);
		return JSON.stringify(out) === JSON.stringify([{ value: "alpha", label: "alpha" }]);
	})(),
);
check(
	"completions level 2: a trailing space completes lane names with full-replacement values",
	(() => {
		const out = lanesCompletions("alpha ", ["alpha"], (w) => (w === "alpha" ? ["docs", "search"] : []));
		return JSON.stringify(out) === JSON.stringify([
			{ value: "alpha docs", label: "docs" },
			{ value: "alpha search", label: "search" },
		]);
	})(),
);
check(
	"completions level 2: prefix filters lanes; three tokens and unknown waves complete nothing",
	lanesCompletions("alpha d", ["alpha"], (w) => (w === "alpha" ? ["docs", "search"] : [])).length === 1 &&
		lanesCompletions("a b c", ["alpha"], () => ["x"]).length === 0 &&
		lanesCompletions("nope ", ["alpha"], () => []).length === 0,
);

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
