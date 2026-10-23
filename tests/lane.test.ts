/**
 * Unit tests for src/lane.ts — slug validation, brief validation, executable
 * resolution, argv construction, kill-target selection.
 * Run: node tests/lane.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_LANE_TOOLS, assertLaneTools, assertSlugs, buildLaneArgs, laneEnv, missingBriefs, resolveExecutable, selectKillTargets, toolEntries } from "../src/lane.ts";
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
const lane = { name: "x", briefPath: "b.md", model: "m1", deadlineSec: 42, tools: "read,bash", noExtensions: true, mcp: false };
const args = buildLaneArgs(lane, cfg, 42, 5);
check(
	"argv: -k grace, deadline, fixed protocol, flags, resolved brief",
	args[0] === "-k" && args[1] === "5" && args[2] === "42" && args[3] === "pi" &&
		args.slice(4, 8).join(" ") === "--mode json --no-session -ns" &&
		args.includes("-ne") && args.includes("--tools") && args[args.indexOf("--tools") + 1] === "read,bash" &&
		args.includes("--no-mcp") && args.includes("--model") && args[args.indexOf("--model") + 1] === "m1" &&
		args[args.length - 1] === `@${path.resolve("b.md")}`,
	JSON.stringify(args),
);
const bare = buildLaneArgs({ name: "x", briefPath: "b.md" }, cfg, 900, 5);
check(
	"argv: omitted tools defaults to the read-only allowlist",
	bare[bare.indexOf("--tools") + 1] === "read,grep,find,ls" && bare.length === 11,
	JSON.stringify(bare),
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

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
