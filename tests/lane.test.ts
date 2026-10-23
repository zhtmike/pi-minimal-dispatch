/**
 * Unit tests for src/lane.ts — slug validation, brief validation, executable
 * resolution, argv construction, kill-target selection.
 * Run: node tests/lane.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertSlugs, buildLaneArgs, laneEnv, missingBriefs, resolveExecutable, selectKillTargets } from "../src/lane.ts";
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
