/**
 * Unit tests for src/derive.ts + src/events.ts — derivation rules from README.md.
 * Run: node tests/derive.test.ts  (cheap CPU: files + ps only, no network/model)
 */

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LaneRecord, type Manifest, deriveLane, deriveLanes, deriveTrace, finalAssistantText, groupAlive, laneEvents, pidAlive, psLstart, psLstartBatch, readManifest, scanWaves, waveSlugsIn, waveTerminal, waitForTerminal, writeManifestAtomic } from "../src/derive.ts";
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
let eventsPath = path.join(tmp, "lane.events.jsonl");
const errPath = path.join(tmp, "lane.err");
let eventsSeq = 0;

// A fresh file per write: transcripts are append-only single-writer streams, and the
// derive cache (rightly) treats a rewrite as shrink-reset or append, never replace.
function writeEvents(lines: string[], truncated = false) {
	eventsPath = path.join(tmp, `lane-${++eventsSeq}.events.jsonl`);
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

// --- inflightTool ------------------------------------------------------------

const toolStart = (id: string, name: string) => JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
const toolEnd = (id: string) => JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: "x", result: {}, isError: false });
const alive = () => lane({ pid: process.pid, processStart: psLstart(process.pid) });

writeEvents([session, turn, assistantEnd({ input: 7 }, "toolUse"), toolStart("c1", "bash")]);
s = deriveLane(alive(), Date.now());
check(
	"inflightTool: latest unmatched tool_execution_start names the running tool",
	s.inflightTool === "bash" && s.state === "running",
	JSON.stringify(s),
);

writeEvents([session, turn, toolStart("c1", "bash"), toolEnd("c1"), toolStart("c2", "read"), toolEnd("c2"), toolStart("c3", "grep")]);
s = deriveLane(alive(), Date.now());
check("inflightTool: paired start/end cancel; only the unmatched start survives", s.inflightTool === "grep");

writeEvents([session, turn, toolStart("c1", "bash"), toolEnd("c1"), '{"type":"agent_settled","aborted":false}']);
s = deriveLane(alive(), Date.now());
check("inflightTool: settled lane with all tools closed carries none", s.state === "settled" && s.inflightTool === undefined);

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

// --- readManifest: the unknown-wave refusal points at where waves live ------

try {
	readManifest(workDir2, "never-existed");
	check("readManifest: unknown wave throws", false);
} catch (e) {
	const msg = String(e);
	check(
		"readManifest: unknown wave names the path and lists live waves",
		msg.includes("unknown wave 'never-existed'") && msg.includes("no manifest at") && msg.includes("ls ") && msg.includes("*-manifest.json"),
		msg,
	);
}

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

// --- waitForTerminal mode: any (first-terminal wake) ------------------------

const workDir3 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-dispatch-any-"));
const slowChild = spawn("sh", ["-c", "sleep 30"]); // real liveness for the still-running lane
const mkAnyLane = (name: string, pid: number): LaneRecord => ({
	name,
	briefPath: "/dev/null",
	eventsPath: path.join(workDir3, `any-${name}.events.jsonl`),
	errPath: path.join(workDir3, `any-${name}.err`),
	pid,
	processStart: psLstart(pid),
	startedAt: new Date().toISOString(),
	deadlineSec: 900,
	spawned: true,
});
const fastLane = mkAnyLane("fast", process.pid);
const slowLane = mkAnyLane("slow", slowChild.pid!);
const anyManifest: Manifest = { version: 1, wave: "any", workDir: workDir3, createdAt: fastLane.startedAt, lanes: [fastLane, slowLane] };
const writeAnyEvents = (lane: LaneRecord, lines: object[]) => fs.writeFileSync(lane.eventsPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
const sessionHeader = { type: "session", id: "s" };
const writeAnyManifest = () => writeManifestAtomic(anyManifest);
const runningEvents = [sessionHeader, { type: "turn_start" }];
fs.writeFileSync(fastLane.errPath, "");
fs.writeFileSync(slowLane.errPath, "");

// wait-any: the first terminal lane wakes the caller while the sibling still runs.
writeAnyEvents(fastLane, runningEvents);
writeAnyEvents(slowLane, runningEvents);
writeAnyManifest();
{
	const timer = setTimeout(() => fs.appendFileSync(fastLane.eventsPath, JSON.stringify({ type: "agent_settled" }) + "\n"), 150);
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 10000, 50, undefined, "any");
	clearTimeout(timer);
	const elapsed = Date.now() - t0;
	check(
		"wait-any: wakes at the first terminal lane with the full status table",
		statuses.length === 2 &&
			statuses.find((s) => s.name === "fast")!.state === "settled" &&
			statuses.find((s) => s.name === "slow")!.state === "running" &&
			elapsed >= 100 && elapsed < 2500,
		JSON.stringify(statuses.map((s) => `${s.name}:${s.state}`)) + ` elapsed ${Date.now() - t0}ms`,
	);
}

// wait-all on the same staging must NOT wake at the first terminal lane.
writeAnyEvents(fastLane, runningEvents);
writeAnyManifest();
{
	const timer = setTimeout(() => fs.appendFileSync(fastLane.eventsPath, JSON.stringify({ type: "agent_settled" }) + "\n"), 150);
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 400, 50, undefined, "all");
	clearTimeout(timer);
	const elapsed = Date.now() - t0;
	check(
		"wait-all: first-terminal does not wake all-mode (timeout returns the table)",
		elapsed >= 380 &&
			elapsed < 2500 &&
			statuses.find((s) => s.name === "fast")!.state === "settled" &&
			statuses.find((s) => s.name === "slow")!.state === "running",
		`elapsed ${elapsed}ms`,
	);
}

// wait-any: every lane already terminal returns immediately, as wait-all does.
fs.writeFileSync(fastLane.eventsPath, JSON.stringify(sessionHeader) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n");
fs.appendFileSync(slowLane.eventsPath, JSON.stringify({ type: "agent_settled" }) + "\n");
writeAnyManifest();
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 5000, 200, undefined, "any");
	const elapsed = Date.now() - t0;
	check(
		"wait-any: all-terminal from start returns immediately",
		statuses.every((s) => s.state === "settled") && elapsed < 1500,
		`elapsed ${elapsed}ms`,
	);
}

// wait-all: a failed lane wakes the default mode — a crash is never sat on behind a sibling.
writeAnyEvents(fastLane, runningEvents);
writeAnyEvents(slowLane, runningEvents);
slowChild.kill("SIGKILL");
await new Promise<void>((r) => slowChild.on("close", () => r()));
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 10000, 50, undefined, "all");
	const elapsed = Date.now() - t0;
	check(
		"wait-all: a crashed lane wakes all-mode within ~pollMs",
		statuses.find((s) => s.name === "fast")!.state === "running" &&
			statuses.find((s) => s.name === "slow")!.state === "failed" &&
			statuses.find((s) => s.name === "slow")!.cause === "crashed" &&
			elapsed < 2500,
		JSON.stringify(statuses.map((s) => `${s.name}:${s.state}:${s.cause}`)) + ` elapsed ${elapsed}ms`,
	);
}

// wait-hold: a known failure does not wake hold-mode — it blocks for the siblings.
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 300, 50, undefined, "hold");
	const elapsed = Date.now() - t0;
	check(
		"wait-hold: sits out the crashed lane, blocks to timeout with the table",
		elapsed >= 280 && elapsed < 2500 &&
			statuses.find((s) => s.name === "fast")!.state === "running" &&
			statuses.find((s) => s.name === "slow")!.state === "failed",
		`elapsed ${elapsed}ms`,
	);
}

// wait-hold: every lane terminal returns immediately.
writeAnyEvents(fastLane, [sessionHeader, { type: "agent_settled" }]);
{
	const t0 = Date.now();
	const statuses = await waitForTerminal(workDir3, "any", 5000, 200, undefined, "hold");
	const elapsed = Date.now() - t0;
	check(
		"wait-hold: all-terminal returns immediately",
		statuses.every((s) => s.state !== "running") && elapsed < 1500,
		JSON.stringify(statuses.map((s) => `${s.name}:${s.state}`)) + ` elapsed ${elapsed}ms`,
	);
}

fs.rmSync(workDir3, { recursive: true, force: true });


// --- deriveTrace --------------------------------------------------------------

{
	const t = (id: string, name: string, extra: object = {}) => JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: name, args: { a: id }, ...extra });
	const end = (id: string, dur: number) => JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: "x", durationMs: dur, result: {}, isError: false });
	writeEvents([session, t("c1", "bash"), end("c1", 8400), t("c2", "grep"), end("c2", 120), t("c3", "read")]);
	const trace = deriveTrace(parseEvents(eventsPath));
	check(
		"trace: matched pairs carry durationMs and close, the unmatched start stays in flight, args ride along",
		trace.tools.length === 3 &&
			trace.tools[0].name === "bash" && trace.tools[0].durationMs === 8400 && trace.tools[0].inflight === undefined &&
			trace.tools[2].name === "read" && trace.tools[2].inflight === true && trace.tools[2].args !== undefined &&
			trace.lastText === "",
		JSON.stringify(trace),
	);

	const many = [session, ...Array.from({ length: 12 }, (_, i) => t(`k${i}`, `tool${i}`))];
	writeEvents(many);
	const trimmed = deriveTrace(parseEvents(eventsPath), 8);
	check(
		"trace: maxTools keeps the tail",
		trimmed.tools.length === 8 && trimmed.tools[0].name === "tool4" && trimmed.tools[7].name === "tool11",
		JSON.stringify(trimmed.tools.map((x) => x.name)),
	);

	writeEvents([session, turn, assistantEnd({ input: 1 }, "stop", { content: [{ type: "text", text: "final words" }] }), '{"type":"agent_settled","aborted":false}']);
	const withText = deriveTrace(parseEvents(eventsPath));
	check("trace: lastText is the last assistant message_end's text", withText.lastText === "final words");
}

// --- scanWaves + waveSlugsIn ---------------------------------------------------

{
	const dirA = path.join(tmp, "scanA");
	const dirB = path.join(tmp, "scanB");
	fs.mkdirSync(dirA, { recursive: true });
	fs.mkdirSync(dirB, { recursive: true });
	writeManifestAtomic({
		version: 1, wave: "alpha", workDir: dirA, createdAt: new Date().toISOString(),
		owner: { sid: "other", pid: deadPid, host: os.hostname(), lstart: "whenever" },
		lanes: [{ name: "one", briefPath: "/dev/null", eventsPath: path.join(dirA, "alpha-one.events.jsonl"), errPath: path.join(dirA, "alpha-one.err"), pid: deadPid, processStart: null, startedAt: new Date().toISOString(), deadlineSec: 900, spawned: true }],
	});
	fs.writeFileSync(path.join(dirB, "beta-manifest.json"), "{corrupt");
	writeManifestAtomic({
		version: 1, wave: "gamma", workDir: dirB, createdAt: new Date().toISOString(),
		owner: { sid: "self", pid: process.pid, host: os.hostname(), lstart: psLstart(process.pid) },
		lanes: [],
	});

	check(
		"waveSlugsIn: manifest filenames only",
		JSON.stringify(waveSlugsIn(dirA)) === JSON.stringify(["alpha"]) && JSON.stringify(waveSlugsIn(dirB).sort()) === JSON.stringify(["beta", "gamma"]),
	);
	check("waveSlugsIn: a missing dir is no suggestions, not a throw", waveSlugsIn(path.join(tmp, "nope")).length === 0);

	const scans = scanWaves([dirA, dirB, dirA], "self", os.hostname(), Date.now());
	const alpha = scans.find((s) => s.wave === "alpha")!;
	const beta = scans.find((s) => s.wave === "beta")!;
	const gamma = scans.find((s) => s.wave === "gamma")!;
	check(
		"scanWaves: dead owner flags prior session, own wave does not, dir dedupe holds",
		scans.length === 3 && alpha.ok && alpha.priorSession === true && alpha.statuses.length === 1 &&
			gamma.ok && gamma.priorSession === false,
		JSON.stringify(scans.map((s) => ({ w: s.wave, ok: s.ok, prior: s.ok ? s.priorSession : undefined }))),
	);
	check(
		"scanWaves: a corrupt manifest is listed with its error, never dropped",
		beta.ok === false && typeof beta.error === "string" && beta.error.length > 0,
		JSON.stringify(beta),
	);
}

// --- incremental transcript cache + batched liveness -------------------------

{
	const inc = path.join(tmp, "inc.events.jsonl");
	const endLine = assistantEnd({ input: 4 }, "stop", { model: "m1" });
	fs.writeFileSync(inc, `${session}\n${turn}\n`);
	let st = laneEvents(inc);
	check("laneEvents: initial parse folds the stream", st.events.length === 2 && st.fold.turns === 1 && st.fold.lastText === "");
	fs.appendFileSync(inc, endLine.slice(0, -5)); // a torn appended tail
	st = laneEvents(inc);
	check("laneEvents: a torn appended tail is held back", st.events.length === 2 && st.fold.usage.input === 0);
	fs.appendFileSync(inc, `${endLine.slice(-5)}\n`); // completing the line
	st = laneEvents(inc);
	check("laneEvents: completing the torn line folds it in", st.events.length === 3 && st.fold.usage.input === 4 && st.fold.stopReason === "stop");
	fs.writeFileSync(inc, `${session}\n`); // a shrink rewrites the stream
	st = laneEvents(inc);
	check("laneEvents: a shrink resets the entry", st.events.length === 1 && st.fold.turns === 0);
}

{
	const p = path.join(tmp, "final-line.events.jsonl");
	fs.writeFileSync(p, `${session}\n${turn}`); // complete JSON, no trailing newline
	check("parseEvents keeps a complete final line that lacks its newline", parseEvents(p).length === 2);
}

{
	const p = path.join(tmp, "corrupt.events.jsonl");
	fs.writeFileSync(p, `${session}\n{oops\n${turn}\n`);
	const s = deriveLane(lane({ eventsPath: p, pid: deadPid }), Date.now());
	check(
		"deriveLane fails soft on a corrupt transcript: failed/crashed, error names the fix",
		s.state === "failed" && s.cause === "crashed" && /corrupt event line 2/.test(s.errTail ?? "") && /kill\/collect\/release remain available/.test(s.errTail ?? ""),
		JSON.stringify(s.errTail),
	);
}

{
	const probe = psLstartBatch([process.pid, deadPid]);
	check(
		"psLstartBatch: live pid listed with its lstart, dead pid absent",
		probe.get(process.pid) === psLstart(process.pid) && !probe.has(deadPid),
		JSON.stringify([...probe.keys()]),
	);
	check(
		"psLstartBatch: a mixed live + out-of-range batch still lists the live pid",
		psLstartBatch([process.pid, 1e9]).get(process.pid) === psLstart(process.pid),
		"the out-of-range pid would kill the whole batch without the MAX_PID filter",
	);
}

{
	const gchild = spawn("sleep", ["5"], { detached: true, stdio: "ignore" });
	gchild.unref();
	await new Promise((r) => setTimeout(r, 200));
	const before = groupAlive(gchild.pid!);
	process.kill(-gchild.pid!, "SIGKILL");
	await new Promise((r) => setTimeout(r, 200));
	check("groupAlive: a live detached group is alive, a killed one is not", before === true && groupAlive(gchild.pid!) === false);
}

{
	const ep = path.join(tmp, "big.err");
	fs.writeFileSync(ep, `${Array.from({ length: 12 }, () => "x".repeat(500)).join("\n")}\n`);
	const s = deriveLane(lane({ eventsPath: path.join(tmp, "no-events.jsonl"), errPath: ep, pid: deadPid }), Date.now());
	const lines = (s.errTail ?? "").split("\n");
	check(
		"errTail: last 5 lines only, each width-capped",
		s.cause === "crashed" && lines.length === 5 && lines.every((l) => l.length === 301 && l.endsWith("…")),
		`first line ${lines[0]?.length} chars, ${lines.length} lines`,
	);
}

{
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "pimd-manifest-"));
	const mp = path.join(d, "w-manifest.json");
	fs.writeFileSync(mp, "");
	let msg = "";
	try {
		readManifest(d, "w");
	} catch (e: any) {
		msg = e.message;
	}
	check("readManifest: an empty manifest names the mid-publish window", /is empty — a dispatch may be mid-publish; retry/.test(msg), msg);
	fs.writeFileSync(mp, "{oops");
	msg = "";
	try {
		readManifest(d, "w");
	} catch (e: any) {
		msg = e.message;
	}
	check("readManifest: invalid JSON names the path", msg.includes(mp) && /invalid manifest JSON/.test(msg), msg);
	fs.rmSync(d, { recursive: true, force: true });
}

{
	const settledPath = path.join(tmp, "sweep-settled.events.jsonl");
	fs.writeFileSync(settledPath, `${session}\n{"type":"agent_settled","aborted":false}\n`);
	const sweepLanes = [
		lane({ name: "dead", eventsPath: path.join(tmp, "sweep-dead.events.jsonl"), pid: deadPid }),
		lane({ name: "alive-settled", eventsPath: settledPath, pid: process.pid, processStart: psLstart(process.pid) }),
		lane({ name: "unspawned", spawned: false, spawnError: "x" }),
	];
	const sweep = deriveLanes(sweepLanes, Date.now());
	const singles = sweepLanes.map((l) => deriveLane(l, Date.now()));
	check(
		"deriveLanes: one sweep derives what per-lane calls derive",
		sweep.every((s, i) => s.state === singles[i].state && s.cause === singles[i].cause && s.turns === singles[i].turns && s.model === singles[i].model),
		JSON.stringify(sweep.map((s) => `${s.name}:${s.state}`)),
	);
}

{
	// A tombstone is authoritative in sweeps even while a group member lingers.
	const tombEvents = path.join(tmp, "tomb.events.jsonl");
	fs.writeFileSync(tombEvents, `${session}\n`);
	const tomb = lane({ name: "tomb", eventsPath: tombEvents, pid: process.pid, processStart: psLstart(process.pid), killedAt: new Date().toISOString() });
	const sweepTomb = deriveLanes([tomb], Date.now());
	check(
		"deriveLanes: a tombstoned lane derives killed, not running",
		sweepTomb[0].state === "failed" && sweepTomb[0].cause === "killed",
		JSON.stringify(sweepTomb[0]),
	);
}

{
	// Slug reuse after release: a recreated file (new inode) must reset, not extend.
	const reuse = path.join(tmp, "reuse.events.jsonl");
	fs.writeFileSync(reuse, `${session}\n`);
	laneEvents(reuse);
	fs.rmSync(reuse);
	const longLine = JSON.stringify({ type: "turn_start" });
	fs.writeFileSync(reuse, `${longLine}\n${longLine}\n${longLine}\n${longLine}\n`); // larger than the old offset
	const st = laneEvents(reuse);
	check("laneEvents: a recreated file resets the entry", st.events.length === 4 && st.fold.turns === 4, `${st.events.length} events`);
	fs.writeFileSync(reuse, `${session}\n${session}\n${session}\n${session}\n${session}\n${session}\n`); // same inode, larger, different stream
	const st2 = laneEvents(reuse);
	check("laneEvents: a same-inode replacement resets via head bytes", st2.events.length === 6 && st2.fold.turns === 0, `${st2.events.length} events`);
}

{
	// First observation of an empty file captures no head; the next read must rebuild one.
	const ef = path.join(tmp, "empty-first.events.jsonl");
	fs.writeFileSync(ef, "");
	laneEvents(ef);
	fs.appendFileSync(ef, `${session}\n${turn}\n`);
	laneEvents(ef); // extend — head rebuilds from a full parse
	const efLine = JSON.stringify({ type: "turn_start" });
	fs.writeFileSync(ef, `${efLine}\n`.repeat(8)); // same inode, larger, different stream
	const st3 = laneEvents(ef);
	check("laneEvents: an empty-first-observation entry still resets on replacement", st3.events.length === 8 && st3.fold.turns === 8, `${st3.events.length} events`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
