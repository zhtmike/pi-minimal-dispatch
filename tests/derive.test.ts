/**
 * Unit tests for src/derive.ts — the derivation rules documented in README.md.
 * Run: node tests/derive.test.ts  (cheap CPU: files + ps only, no network/model)
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type LaneRecord,
	deriveLane,
	finalAssistantText,
	parseEvents,
	pidAlive,
	psLstart,
} from "../src/derive.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-dispatch-test-"));
const eventsPath = path.join(tmp, "lane.events.jsonl");
const errPath = path.join(tmp, "lane.err");

function writeEvents(lines: string[], truncated = false) {
	fs.writeFileSync(eventsPath, lines.join("\n") + (truncated ? "" : "\n"));
}

function lane(over: Partial<LaneRecord>): LaneRecord {
	return {
		name: "lane",
		briefPath: "/dev/null",
		eventsPath,
		errPath,
		pid: null,
		processStart: null,
		startedAt: new Date().toISOString(),
		deadlineSec: 900,
		spawned: true,
		...over,
	};
}

// A pid that is certainly dead.
const dead = spawnSync("sh", ["-c", "exit 0"]);
const deadPid = dead.pid!;

const session = JSON.stringify({ type: "session", id: "s" });
const turn = JSON.stringify({ type: "turn_start" });
const assistantEnd = (usage: object, stopReason: string) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason, usage, content: [] } });

// --- parseEvents -----------------------------------------------------------

writeEvents([session, turn, '{"type":"agent_settled","aborted":fals'], true); // trailing line truncated
check("parseEvents skips a truncated trailing line", parseEvents(eventsPath).length === 2);

writeEvents([session, "{corrupt middle", turn]);
let threw = false;
try {
	parseEvents(eventsPath);
} catch {
	threw = true;
}
check("parseEvents throws on mid-file corruption", threw);

// --- deriveLane ------------------------------------------------------------

writeEvents([session, turn, assistantEnd({ input: 10, output: 2, cost: { total: 0.001 } }, "toolUse"), assistantEnd({ input: 5, output: 1, cost: { total: 0.002 } }, "stop"), '{"type":"agent_settled","aborted":false}']);
let s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid) }), Date.now());
check(
	"settled: state + usage summed over assistant message_end + last stopReason",
	s.state === "settled" && s.usage.input === 15 && s.usage.output === 3 && s.usage.cost === 0.003 && s.stopReason === "stop",
	JSON.stringify(s),
);
check("settled: turns counted", s.turns === 1);

writeEvents([session, turn, assistantEnd({ input: 7 }, "toolUse")]);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid) }), Date.now());
check("running: alive + session header, no agent_settled", s.state === "running" && !s.overdue);

writeEvents([]);
fs.rmSync(eventsPath);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid) }), Date.now());
check("starting: alive, no events file yet", s.state === "starting");

writeEvents([session, turn, assistantEnd({ input: 7 }, "toolUse")]);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid), startedAt: new Date(Date.now() - 20000).toISOString(), deadlineSec: 5 }), Date.now());
check("running + overdue: alive past deadline keeps running with overdue flag", s.state === "running" && s.overdue === true, JSON.stringify(s));

writeEvents([session]);
fs.writeFileSync(errPath, "boom\nboom2\n");
s = deriveLane(lane({ pid: deadPid }), Date.now());
check(
	"crashed: dead before deadline, .err tail attached",
	s.state === "failed" && s.cause === "crashed" && s.errTail === "boom\nboom2",
	JSON.stringify(s),
);

writeEvents([session]);
s = deriveLane(lane({ pid: deadPid, startedAt: new Date(Date.now() - 20000).toISOString(), deadlineSec: 5 }), Date.now());
check("deadline: dead + past deadline, no tombstone", s.state === "failed" && s.cause === "deadline");

s = deriveLane(
	lane({ pid: deadPid, startedAt: new Date(Date.now() - 20000).toISOString(), deadlineSec: 5, killedAt: new Date().toISOString() }),
	Date.now(),
);
check("killed: tombstone wins over deadline", s.state === "failed" && s.cause === "killed");

writeEvents([session]);
s = deriveLane(lane({ spawned: false, spawnError: "ENOENT pi" }), Date.now());
check("spawn failure surfaces as failed/spawn", s.state === "failed" && s.cause === "spawn" && s.spawnError === "ENOENT pi");

// --- pidAlive reuse guard --------------------------------------------------

check("pidAlive: own pid + matching start = alive", pidAlive(process.pid, psLstart(process.pid)));
check("pidAlive: alive pid with wrong start-time = dead (reused PID)", !pidAlive(process.pid, "bogus start"));
check("pidAlive: dead pid = dead", !pidAlive(deadPid, null));

// --- finalAssistantText ----------------------------------------------------

const events = [
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "A" }, { type: "text", text: "B" }] } },
];
check("finalAssistantText: last assistant message, text blocks joined", finalAssistantText(events) === "A\nB");
check("finalAssistantText: no assistant message = empty", finalAssistantText([{ type: "message_end", message: { role: "user", content: "q" } }]) === "");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
