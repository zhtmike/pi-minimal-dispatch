/**
 * Unit tests for the release/ownership core in src/derive.ts — ownerStatus,
 * ownerGuard, releasePaths, releaseWave, unconsumedTranscripts. Run: node tests/release.test.ts
 * (cheap CPU: files + ps only, no network/model)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import {
	type LaneRecord,
	type Manifest,
	type WaveOwner,
	ownerGuard,
	ownerStatus,
	psLstart,
	releasePaths,
	releaseWave,
	unconsumedTranscripts,
	waveTerminal,
} from "../src/derive.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const tmp = fs.mkdtempSync(path.join("/tmp", "pmd-release-test-"));
const host = hostname();
const selfLstart = psLstart(process.pid);

function owner(over: Partial<WaveOwner>): WaveOwner {
	return { sid: "self", pid: process.pid, host, lstart: selfLstart, ...over };
}

function lane(over: Partial<LaneRecord>): LaneRecord {
	return {
		name: "solo",
		briefPath: path.join(tmp, "solo.brief.md"),
		eventsPath: path.join(tmp, "w-solo.events.jsonl"),
		errPath: path.join(tmp, "w-solo.err"),
		pid: null,
		processStart: null,
		startedAt: new Date().toISOString(),
		deadlineSec: 900,
		spawned: false,
		spawnError: "fixture: never spawned",
		...over,
	};
}

function manifest(over: Partial<Manifest>): Manifest {
	return { version: 1, wave: "w", workDir: tmp, createdAt: new Date().toISOString(), owner: owner({}), lanes: [lane({})], ...over };
}

// --- ownerStatus -----------------------------------------------------------

check("own: sid match wins over everything", ownerStatus(owner({ pid: 1, lstart: "bogus" }), "self", host) === "own");
check(
	"live-foreign: same host, live pid, matching lstart",
	ownerStatus(owner({ sid: "other" }), "self", host) === "live-foreign",
);
check(
	"dead: same host, foreign sid, dead pid",
	ownerStatus(owner({ sid: "other", pid: spawnSync("true").pid! }), "self", host) === "dead",
);
check("foreign-host: different host is neither live nor dead", ownerStatus(owner({ sid: "other", host: "elsewhere" }), "self", host) === "foreign-host");
check("unknown: absent owner (legacy manifest)", ownerStatus(undefined, "self", host) === "unknown");
check("unknown: null owner (hand-edited manifest)", ownerStatus(null as unknown as WaveOwner | undefined, "self", host) === "unknown");
check("unknown: empty sid", ownerStatus(owner({ sid: "" }), "self", host) === "unknown");
check("unknown: non-integer pid", ownerStatus(owner({ pid: 1.5 }), "self", host) === "unknown");
check("unknown: empty lstart", ownerStatus(owner({ lstart: "" }), "self", host) === "unknown");
check("unknown: empty host", ownerStatus(owner({ host: "" }), "self", host) === "unknown");

// --- ownerGuard ------------------------------------------------------------

check("guard own: ok", ownerGuard(owner({}), "self", host, "w").ok === true);
check("guard dead: ok — adoptable", ownerGuard(owner({ sid: "other", pid: spawnSync("true").pid! }), "self", host, "w").ok === true);
check("guard live-foreign: refused with reason", ownerGuard(owner({ sid: "other" }), "self", host, "w").ok === false);
check("guard foreign-host: refused", ownerGuard(owner({ sid: "other", host: "elsewhere" }), "self", host, "w").ok === false);
check("guard unknown: refused — legacy manifests never mechanically releasable", ownerGuard(undefined, "self", host, "w").ok === false);
check("guard refusal names the wave", (ownerGuard(owner({ sid: "other" }), "self", host, "w") as { reason: string }).reason.includes("'w'"));

// --- releasePaths ----------------------------------------------------------

const twoLane = manifest({
	lanes: [
		lane({ name: "alpha", briefPath: path.join(tmp, "a.brief.md"), eventsPath: path.join(tmp, "w-a.events.jsonl"), errPath: path.join(tmp, "w-a.err") }),
		lane({ name: "beta", briefPath: path.join(tmp, "b.brief.md"), eventsPath: path.join(tmp, "w-b.events.jsonl"), errPath: path.join(tmp, "w-b.err") }),
	],
});
const paths = releasePaths(twoLane).sort();
check(
	"releasePaths: briefs, events, err, collect artifact per lane + manifest (9 for 2 lanes)",
	paths.length === 9 &&
		paths.includes(path.join(tmp, "a.brief.md")) && // briefs come from the record, not a pattern
		paths.includes(path.join(tmp, "w-a.events.jsonl")) &&
		paths.includes(path.join(tmp, "w-b.err")) &&
		paths.includes(path.join(tmp, "w-beta.md")) &&
		paths.includes(path.join(tmp, "w-manifest.json")),
	JSON.stringify(paths),
);

// --- releaseWave -----------------------------------------------------------

const brief = path.join(tmp, "solo.brief.md");
const events = path.join(tmp, "w-solo.events.jsonl");
const err = path.join(tmp, "w-solo.err");
const artifact = path.join(tmp, "w-solo.md");
const manifestFile = path.join(tmp, "w-manifest.json");
for (const p of [brief, events, err, artifact, manifestFile]) fs.writeFileSync(p, "fixture\n");

const solo = manifest({ lanes: [lane({ briefPath: brief, eventsPath: events, errPath: err })] });
fs.writeFileSync(manifestFile, JSON.stringify(solo));
const result = releaseWave(solo);
check(
	"releaseWave: deletes exactly the enumerated set",
	result.deleted.length === 5 &&
		result.absent === 0 &&
		![brief, events, err, artifact, manifestFile].some((p) => fs.existsSync(p)),
	JSON.stringify(result),
);

fs.writeFileSync(manifestFile, "{}");
const absentRun = releaseWave(solo);
check(
	"releaseWave: ENOENT within the set is tolerated and counted",
	absentRun.absent === 4 && absentRun.deleted.length === 1,
	JSON.stringify(absentRun),
);

// --- terminality interplay (the release precondition) ----------------------

const settled = manifest({ lanes: [lane({})] }); // unspawned lane is terminal (failed/spawn)
check("unspawned-only wave counts as terminal for release", waveTerminal(settled.lanes, Date.now()) === true);
const running = manifest({
	lanes: [lane({ spawned: true, spawnError: undefined, pid: process.pid, processStart: selfLstart })],
});
check("live running lane keeps the wave non-terminal", waveTerminal(running.lanes, Date.now()) === false);

// --- unconsumed transcripts (the release precondition) ---------------------

const uEvents = path.join(tmp, "w-un.events.jsonl");
const uArtifact = path.join(tmp, "w-un.md");
const uWave = manifest({ lanes: [lane({ name: "un", spawned: true, spawnError: undefined, eventsPath: uEvents })] });

check("unconsumed: absent events never blocks (already released)", unconsumedTranscripts(uWave).length === 0);

fs.writeFileSync(uEvents, "fixture\n");
check(
	"unconsumed: spawned lane with events but no artifact is named",
	JSON.stringify(unconsumedTranscripts(uWave)) === JSON.stringify(["un"]),
	JSON.stringify(unconsumedTranscripts(uWave)),
);

fs.writeFileSync(uArtifact, "fixture\n");
check("unconsumed: artifact present means consumed", unconsumedTranscripts(uWave).length === 0);

const nEvents = path.join(tmp, "w-ns.events.jsonl");
fs.writeFileSync(nEvents, "fixture\n"); // spawnLane opens the events file before spawning
check(
	"unconsumed: never-spawned lane never blocks (collect refuses it)",
	unconsumedTranscripts(manifest({ lanes: [lane({ name: "ns", eventsPath: nEvents })] })).length === 0,
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
