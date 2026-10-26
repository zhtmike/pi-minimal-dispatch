/**
 * Unit tests for src/derive.ts + src/events.ts — derivation rules from README.md.
 * Run: node tests/derive.test.ts  (cheap CPU: files + ps only, no network/model)
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LaneRecord, type Manifest, deriveLane, finalAssistantText, pidAlive, psLstart, waveTerminal, waitForTerminal, writeManifestAtomic } from "../src/derive.ts";
import { parseEvents } from "../src/events.ts";

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
const assistantEnd = (usage: object, stopReason: string, extra: object = {}) =>
	JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason, usage, content: [], ...extra } });
const assistantStart = (extra: object = {}) =>
	JSON.stringify({ type: "message_start", message: { role: "assistant", stopReason: "pending", usage: {}, content: [], ...extra } });

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

// --- model + thinkingLevel -------------------------------------------------

writeEvents([session, turn,
	assistantEnd({ input: 1 }, "toolUse", { model: "zai/glm-4.6", thinkingLevel: "high" }),
	assistantEnd({ input: 1 }, "stop", { model: "zai/glm-5.3-flash" }),
]);
s = deriveLane(lane({ pid: deadPid }), Date.now());
check(
	"model: last assistant message wins; a message without thinkingLevel clears it",
	s.model === "zai/glm-5.3-flash" && s.thinkingLevel === undefined,
	JSON.stringify(s),
);

writeEvents([session]);
s = deriveLane(lane({ pid: deadPid, model: "zai/glm-4.6:high" }), Date.now());
check(
	"model fallback: pinned `:thinking` suffix split off",
	s.model === "zai/glm-4.6" && s.thinkingLevel === "high",
	JSON.stringify(s),
);

s = deriveLane(lane({ pid: deadPid, model: "zai/glm-4.6:low", thinking: "high" }), Date.now());
check(
	"thinking fallback: explicit pin wins over the model's `:level` suffix (pi precedence)",
	s.model === "zai/glm-4.6" && s.thinkingLevel === "high",
	JSON.stringify(s),
);

s = deriveLane(lane({ pid: deadPid, model: "openrouter/qwen/qwen3-coder:exacto" }), Date.now());
check(
	"model fallback: a colon suffix that is not a level word stays part of the id",
	s.model === "openrouter/qwen/qwen3-coder:exacto" && s.thinkingLevel === undefined,
	JSON.stringify(s),
);

// message_start: early model identity before the first message_end
writeEvents([session, turn, assistantStart({ model: "zai/glm-5.3" }), '{"type":"message_update","message":{"role":"assistant"}}']);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid) }), Date.now());
check(
	"message_start supplies the answering model before any message_end (no-pin lane)",
	s.model === "zai/glm-5.3" && s.usage.input === 0,
	JSON.stringify(s.model),
);

writeEvents([session, turn,
	assistantStart({ model: "zai/glm-4.6" }),
	assistantEnd({ input: 1 }, "toolUse", { model: "zai/glm-4.6", thinkingLevel: "high" }),
	assistantStart({ model: "zai/glm-5.3-flash" }),
]);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid) }), Date.now());
check(
	"message_start after a model switch updates the model; the stale level waits for message_end (additive)",
	s.model === "zai/glm-5.3-flash" && s.thinkingLevel === "high",
	JSON.stringify({ model: s.model, thinkingLevel: s.thinkingLevel }),
);

writeEvents([session, turn, assistantStart({ model: "zai/glm-5.3-flash" })]);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid), model: "zai/glm-5.3-flash:low" }), Date.now());
check(
	"message_start additive: a matching model keeps the pinned level until message_end",
	s.model === "zai/glm-5.3-flash" && s.thinkingLevel === "low",
	JSON.stringify({ model: s.model, thinkingLevel: s.thinkingLevel }),
);

writeEvents([session, turn, assistantStart({ model: "glm-5.3-flash" })]);
s = deriveLane(lane({ pid: process.pid, processStart: psLstart(process.pid), model: "zai/glm-5.3-flash:low" }), Date.now());
check(
	"message_start additive across forms: bare stream id over a provider-qualified pin keeps the pinned level",
	s.model === "glm-5.3-flash" && s.thinkingLevel === "low",
	JSON.stringify({ model: s.model, thinkingLevel: s.thinkingLevel }),
);

writeEvents([session]);
s = deriveLane(lane({ pid: deadPid, model: "zai/glm-4.6" }), Date.now());
check(
	"model fallback: plain pinned id passes through; unpinned stays undefined",
	s.model === "zai/glm-4.6" && s.thinkingLevel === undefined && deriveLane(lane({ pid: deadPid }), Date.now()).model === undefined,
	JSON.stringify(s),
);

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

// --- waveTerminal + waitForTerminal -----------------------------------------

const workDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-dispatch-wait-"));
const wEvents = path.join(workDir2, "w.events.jsonl");
const wErr = path.join(workDir2, "w.err");
const child = spawn("sh", ["-c", "sleep 30"]); // real liveness for the running state
const wLane: LaneRecord = {
	name: "w",
	briefPath: "/dev/null",
	eventsPath: wEvents,
	errPath: wErr,
	pid: child.pid!,
	processStart: psLstart(child.pid!),
	startedAt: new Date().toISOString(),
	deadlineSec: 900,
	spawned: true,
};
const manifest: Manifest = { version: 1, wave: "w", workDir: workDir2, createdAt: wLane.startedAt, lanes: [wLane] };
const writeWEvents = (lines: string[]) => fs.writeFileSync(wEvents, lines.join("\n") + "\n");
const writeWManifest = () => writeManifestAtomic(manifest);
fs.writeFileSync(wErr, "");

// Running: session header only.
writeWEvents([JSON.stringify({ type: "session", id: "s" })]);
writeWManifest();
check("waveTerminal: running wave is not terminal", !waveTerminal(manifest.lanes, Date.now()));

// Settled: agent_settled wins even while the pid lives.
writeWEvents([JSON.stringify({ type: "session", id: "s" }), JSON.stringify({ type: "agent_settled" })]);
check("waveTerminal: settled wave is terminal", waveTerminal(manifest.lanes, Date.now()));
check("waveTerminal: spawn-failed lane is terminal", waveTerminal([{ ...wLane, pid: null, spawned: false }], Date.now()));

// waitForTerminal: already terminal resolves without sleeping a full poll.
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir2, "w", 5000, 200);
	const elapsed = Date.now() - t0;
	check(
		"waitForTerminal: terminal-from-start returns immediately",
		statuses.length === 1 && statuses[0].state === "settled" && elapsed < 1500,
		`elapsed ${elapsed}ms`,
	);
}

// waitForTerminal: timeout with a running lane is a normal result.
writeWEvents([JSON.stringify({ type: "session", id: "s" })]);
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir2, "w", 300, 50);
	const elapsed = Date.now() - t0;
	check(
		"waitForTerminal: timeout returns running lanes, never throws",
		statuses[0].state === "running" && elapsed >= 280 && elapsed < 2500,
		`state ${statuses[0].state} elapsed ${elapsed}ms`,
	);
}

// waitForTerminal: a settle mid-wait wakes the caller at the poll cadence.
{
	const timer = setTimeout(() => fs.appendFileSync(wEvents, JSON.stringify({ type: "agent_settled" }) + "\n"), 150);
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir2, "w", 10000, 50);
	clearTimeout(timer);
	const elapsed = Date.now() - t0;
	check(
		"waitForTerminal: mid-wait settle wakes within ~pollMs",
		statuses[0].state === "settled" && elapsed >= 100 && elapsed < 2500,
		`state ${statuses[0].state} elapsed ${elapsed}ms`,
	);
}

// waitForTerminal: an aborted signal wakes at the abort instant, not at the next poll.
writeWEvents([JSON.stringify({ type: "session", id: "s" })]);
{
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 120);
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir2, "w", 10000, 2000, controller.signal);
	const elapsed = Date.now() - t0;
	check(
		"waitForTerminal: abort wakes immediately with current state",
		statuses[0].state === "running" && elapsed >= 100 && elapsed < 1000,
		`state ${statuses[0].state} elapsed ${elapsed}ms`,
	);
}

child.kill("SIGKILL");
fs.rmSync(workDir2, { recursive: true, force: true });

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
