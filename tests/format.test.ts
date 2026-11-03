/**
 * Unit tests for src/format.ts — presentation formatters from README.md.
 * Run: node tests/format.test.ts
 */

import type { LaneStatus } from "../src/derive.ts";
import { type TraceSummary, type WaveScan } from "../src/derive.ts";
import {
	IDLE_AFTER_SEC,
	TRACE_SNIPPET_CHARS,
	displayPath,
	fileUri,
	formatCollectEntry,
	formatDuration,
	formatInlineArtifact,
	formatLaneInspector,
	formatMillis,
	formatLaneLine,
	formatStatusBarSummary,
	formatWaveHeader,
	formatWaveList,
	formatWaveStatusTui,
	lanesUsageLine,
	plainPath,
	snippet,
	suspectOf,
} from "../src/format.ts";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

const st = (over: Partial<LaneStatus>): LaneStatus => ({
	name: "lane",
	state: "running",
	turns: 1,
	usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
	lastEventAgeSec: 1,
	...over,
});

check(
	"statusbar: running lanes produce a summary; starting counts as running",
	formatStatusBarSummary([st({ state: "running" }), st({ state: "starting", name: "b" }), st({ state: "settled", name: "c" })]) === "lanes: 2 running · 1 settled",
);
check(
	"statusbar: done buckets in stable sorted order — the failed bucket carries its cause",
	formatStatusBarSummary([st({ state: "settled" }), st({ state: "running" }), st({ state: "failed", cause: "crashed", name: "d" })]) === "lanes: 1 running · 1 failed (crashed) · 1 settled",
);
check(
	"statusbar: an unreleased failure keeps the footer; settled-only and empty clear it",
	formatStatusBarSummary([st({ state: "settled" }), st({ state: "failed", cause: "deadline", name: "b" })]) === "lanes: 1 failed (deadline) · 1 settled" &&
		formatStatusBarSummary([st({ state: "settled" }), st({ state: "settled", name: "b" })]) === undefined &&
		formatStatusBarSummary([]) === undefined,
);

// --- statusbar: badges, telemetry, composition -------------------------------

check(
	"statusbar telemetry: one running wave-tagged lane — turn, in-flight tool, honest age",
	formatStatusBarSummary([{ ...st({ name: "docs", turns: 3, inflightTool: "bash", lastEventAgeSec: 12 }), wave: "survey" }]) ===
		"lanes [survey/docs]: running (turn 3 · bash · last 12s)",
	formatStatusBarSummary([{ ...st({ name: "docs", turns: 3, inflightTool: "bash", lastEventAgeSec: 12 }), wave: "survey" }]),
);
check(
	"statusbar telemetry: no in-flight tool or age yet — those bits drop out",
	formatStatusBarSummary([{ ...st({ name: "docs", inflightTool: undefined, lastEventAgeSec: null }), wave: "survey" }]) ===
		"lanes [survey/docs]: running (turn 1)",
);
check(
	"statusbar telemetry: needs the wave tag, a running (not starting) lane, and no sibling in flight",
	formatStatusBarSummary([st({ name: "docs" })]) === "lanes: 1 running" &&
		formatStatusBarSummary([{ ...st({ name: "docs" }), wave: "survey" }, st({ state: "starting", name: "b" })]) === "lanes: 2 running",
);
check(
	"statusbar idle: a lane silent past the threshold badges with its honest age (59 no, 60/74.7 yes)",
	formatStatusBarSummary([st({ lastEventAgeSec: IDLE_AFTER_SEC - 1 })]) === "lanes: 1 running" &&
		formatStatusBarSummary([st({ lastEventAgeSec: IDLE_AFTER_SEC })]) === "lanes: 1 running · (1 idle 60s)" &&
		formatStatusBarSummary([st({ lastEventAgeSec: 74.7 })]) === "lanes: 1 running · (1 idle 75s)",
);
check(
	"statusbar idle: several stale lanes badge once with the oldest age",
	formatStatusBarSummary([st({ lastEventAgeSec: 61 }), st({ name: "b", lastEventAgeSec: 180 })]) === "lanes: 2 running · (2 idle 180s)",
);
check(
	"statusbar overdue: overdue-but-fresh badges overdue; overdue-and-stale stays overdue, never a mixed double badge",
	formatStatusBarSummary([st({ overdue: true, lastEventAgeSec: 5 })]) === "lanes: 1 running · (1 overdue)" &&
		formatStatusBarSummary([st({ overdue: true, lastEventAgeSec: 300 })]) === "lanes: 1 running · (1 overdue)" &&
		formatStatusBarSummary([st({ overdue: true, lastEventAgeSec: 5 }), st({ name: "b", lastEventAgeSec: 75 })]) === "lanes: 2 running · (1 idle 75s · 1 overdue)",
);
check(
	"statusbar composition: telemetry · badge · failed · settled, empty segments dropped",
	formatStatusBarSummary([
		{ ...st({ name: "docs", turns: 3, inflightTool: "grep", lastEventAgeSec: 90, overdue: true }), wave: "survey" },
		st({ state: "failed", cause: "deadline", name: "b" }),
		st({ state: "settled", name: "c" }),
	]) === "lanes [survey/docs]: running (turn 3 · grep · last 90s) · (1 overdue) · 1 failed (deadline) · 1 settled",
);
check(
	"statusbar: failed without a cause renders the bare bucket",
	formatStatusBarSummary([st({ state: "failed", cause: undefined, name: "b" })]) === "lanes: 1 failed",
);

// --- TUI path display --------------------------------------------------------

check(
	"paths: under cwd display ./-relative; outside stays absolute; cwd itself stays put",
	displayPath("/repo/.pi/work/w-docs.md", "/repo") === "./.pi/work/w-docs.md" &&
		displayPath("/elsewhere/x.md", "/repo") === "/elsewhere/x.md" &&
		displayPath("/repo", "/repo") === "/repo" &&
		displayPath("/repo2/x.md", "/repo") === "/repo2/x.md",
);
check(
	"paths: plain fallback collapses home to ~, never a bare relative",
	plainPath("/Users/me/.pi/work/x.md", "/Users/me") === "~/.pi/work/x.md" &&
		plainPath("/Users/mex/x.md", "/Users/me") === "/Users/mex/x.md" &&
		plainPath("/Users/me", "/Users/me") === "~",
);
check(
	"paths: file URI is pi core's pathToFileURL form (encoded)",
	fileUri("/tmp/a b/c#d.md") === "file:///tmp/a%20b/c%23d.md",
);
check(
	"lanes tui table: failed lanes gain linked files, others stay unchanged",
	(() => {
		const seen: string[] = [];
		const link = (p: string) => (seen.push(p), `<${p}>`);
		const out = formatWaveStatusTui(
			"w",
			[
				{ status: st({ state: "failed", cause: "crashed", name: "a" }), eventsPath: "/w/w-a.events.jsonl", errPath: "/w/w-a.err" },
				{ status: st({ name: "b" }), eventsPath: "/w/w-b.events.jsonl", errPath: "/w/w-b.err" },
			],
			link,
		);
		return (
			out.includes("\n    files: </w/w-a.events.jsonl> · </w/w-a.err>") &&
			!out.includes("w-b.events") && seen.length === 2
		);
	})(),
);
check(
	"lane line: cause, overdue, singular turns, err tail indentation",
	formatLaneLine(st({ state: "failed", cause: "crashed", errTail: "boom\nsecond" })).includes("lane [default] · failed · (crashed)") &&
		formatLaneLine(st({ state: "running", overdue: true })).includes("OVERDUE") &&
		formatLaneLine(st({ state: "running" })).includes("1 turn") &&
		formatLaneLine(st({ state: "running", turns: 2 })).includes("2 turns") &&
		formatLaneLine(st({ state: "failed", cause: "crashed", errTail: "boom" })).includes("\n    err: boom"),
);
check(
	"lane line: model tag after name, provider prefix dropped, thinking only when present",
	formatLaneLine(st({ model: "openrouter/zai/glm-4.6", thinkingLevel: "high" })).includes("lane [glm-4.6 think:high] · running") &&
		formatLaneLine(st({ model: "zai/glm-5.3-flash" })).includes("lane [glm-5.3-flash] · running"),
);
check(
	"lane line: no model yet renders [default] — never an absent tag",
	formatLaneLine(st({})).includes("lane [default] · running"),
);

// --- suspectOf (flag + first-applicable cause) ------------------------------

check(
	"suspect: failed beats empty and stop (first applicable), cause carries the lane's failure cause",
	suspectOf(st({ state: "failed", cause: "deadline" }), "partial text").suspect === true &&
		suspectOf(st({ state: "failed", cause: "killed" }), "partial text").cause === "failed:killed" &&
		suspectOf(st({ state: "failed", cause: "crashed" }), "").cause === "failed:crashed",
);
check(
	"suspect: empty final text when not failed",
	suspectOf(st({ state: "settled" }), "").suspect === true && suspectOf(st({ state: "settled" }), "").cause === "empty",
);
check(
	"suspect: non-clean stop reason when text is present",
	suspectOf(st({ state: "settled", stopReason: "length" }), "answer").suspect === true &&
		suspectOf(st({ state: "settled", stopReason: "length" }), "answer").cause === "stop:length",
);
check(
	"suspect: clean lane is not suspect and carries no cause",
	(() => {
		const s = suspectOf(st({ state: "settled", stopReason: "stop" }), "answer");
		return s.suspect === false && s.cause === undefined;
	})(),
);

// --- formatCollectEntry (line + inline block) --------------------------------

const okEntry = { name: "docs", artifact: "/w/w-docs.md", suspect: false, stopReason: "stop", content: "findings\n" };
check(
	"collect line: clean lane unchanged, no tag",
	formatCollectEntry(okEntry, 0) === "  docs: /w/w-docs.md stop:stop",
	formatCollectEntry(okEntry, 0),
);
check(
	"collect line: suspect renders its cause after SUSPECT",
	formatCollectEntry({ ...okEntry, suspect: true, suspectCause: "failed:deadline" }, 0) === "  docs: /w/w-docs.md [SUSPECT: failed:deadline] stop:stop",
);
check(
	"collect line: refused lane renders its reason",
	formatCollectEntry({ name: "docs", reason: "still running — refused" }, 1 << 20) === "  docs: still running — refused",
);
check(
	"collect inline: suspect never inlines however small",
	formatCollectEntry({ ...okEntry, suspect: true, suspectCause: "empty" }, 1 << 20) === "  docs: /w/w-docs.md [SUSPECT: empty] stop:stop",
);
check(
	"collect inline: under budget the artifact content follows its line in a 3-fence",
	formatCollectEntry(okEntry, 100) === "  docs: /w/w-docs.md stop:stop\n```\nfindings\n```",
	JSON.stringify(formatCollectEntry(okEntry, 100)),
);
check(
	"collect inline: content fence runs grow the fence (3-run → 4, 5-run → 6)",
	(() => {
		const three = formatInlineArtifact("a```b\n", "/w/a.md", 100);
		const five = formatInlineArtifact("a`````b\n", "/w/a.md", 100);
		return (
			three.startsWith("````\n") && three.endsWith("\n````") &&
			five.startsWith("``````\n") && five.endsWith("\n``````")
		);
	})(),
);
check(
	"collect inline: over budget truncates with total bytes and the artifact path",
	(() => {
		const out = formatInlineArtifact("abcdefgh\n", "/w/w-docs.md", 4);
		return out === "```\nabcd\n… [truncated, total 9 bytes — read /w/w-docs.md for the rest]\n```";
	})(),
	formatInlineArtifact("abcdefgh\n", "/w/w-docs.md", 4),
);
check(
	"collect inline: truncation lands on the last complete multibyte character, never a split one",
	(() => {
		// 中 is 3 bytes; 7 bytes = 中中 + 1 byte of the third — the cut backs off to exactly two
		const out = formatInlineArtifact("中中中中", "/w/a.md", 7);
		return out.includes("\n中中\n… [truncated, total 12 bytes") && !out.includes("\uFFFD");
	})(),
	JSON.stringify(formatInlineArtifact("中中中中", "/w/a.md", 7)),
);
check(
	"collect inline: exactly-budget content inlines whole without a marker",
	(() => {
		const out = formatInlineArtifact("中中", "/w/a.md", 6);
		return out === "```\n中中\n```";
	})(),
);
check(
	"collect inline: a truncated body already ending in a newline takes the marker without a blank line",
	(() => {
		// 13 bytes total; the 4-byte budget cuts after "abc\n" — the third 中's lead byte backs the cut off
		const out = formatInlineArtifact("abc\n中中中", "/w/a.md", 4);
		return out === "```\nabc\n… [truncated, total 13 bytes — read /w/a.md for the rest]\n```";
	})(),
	JSON.stringify(formatInlineArtifact("abc\n中中中", "/w/a.md", 4)),
);
check(
	"collect line: suspect without a cause renders the bare [SUSPECT] tag",
	formatCollectEntry({ ...okEntry, suspect: true }, 0) === "  docs: /w/w-docs.md [SUSPECT] stop:stop",
);


// --- /lanes inspector surfaces ---------------------------------------------

check(
	"snippet: single-lined and capped at the fixed width, strings unquoted",
	snippet({ command: "a\nb c" }) === '{"command":"a\\nb c"}' &&
		snippet("plain text") === "plain text" &&
		snippet("x".repeat(TRACE_SNIPPET_CHARS + 10)).length === TRACE_SNIPPET_CHARS + 1 &&
		snippet("x".repeat(TRACE_SNIPPET_CHARS + 10)).endsWith("…"),
);
check(
	"millis: sub-second precision kept for tool durations",
	formatMillis(840) === "840ms" && formatMillis(8400) === "8.4s" && formatMillis(62_000) === "1m02s",
);
check(
	"duration: seconds, minutes+seconds, hours+minutes",
	formatDuration(45) === "45s" && formatDuration(750) === "12m30s" && formatDuration(3900) === "1h05m" && formatDuration(0) === "0s",
);
check("usage line: the three forms, one line", lanesUsageLine() === "usage: /lanes [wave] [lane] — list waves · inspect one wave · inspect one lane");

const scanOk = (wave: string, over: Partial<Extract<WaveScan, { ok: true }>> = {}): WaveScan =>
	({ ok: true, wave, workDir: "/w", statuses: [st({ name: "a" }), st({ state: "settled", name: "b" })], priorSession: false, createdAt: new Date().toISOString(), ...over });
check(
	"wave list: lane count + aggregate state, prior-session tag, corrupt manifest listed, usage line last",
	(() => {
		const out = formatWaveList([
			scanOk("alpha"),
			scanOk("beta", { priorSession: true, statuses: [st({ state: "failed", cause: "deadline", name: "a" })] }),
			{ ok: false, wave: "broken", workDir: "/w", error: "Unexpected token" },
		]);
		return (
			out.includes("alpha — 2 lanes · 1 running · 1 settled") &&
			out.includes("beta (prior session) — 1 lane · 1 failed") &&
			out.includes("broken — manifest error: Unexpected token") &&
			out.endsWith(lanesUsageLine())
		);
	})(),
	formatWaveList([scanOk("alpha")]),
);
check(
	"wave list: empty scan says no waves, still ends with the usage line",
	formatWaveList([]) === `waves:\n  no waves found\n${lanesUsageLine()}`,
);
check(
	"wave header: wall clock since dispatch + pure usage sums over statuses",
	formatWaveHeader("w", new Date(Date.now() - 750_000).toISOString(), [st({ name: "a" }), st({ name: "b" })], Date.now()).includes("12m30s since dispatch · 2 lanes · tok 20in/4out · $0.0020"),
	formatWaveHeader("w", new Date(Date.now() - 750_000).toISOString(), [st({ name: "a" }), st({ name: "b" })], Date.now()),
);

const inspTrace: TraceSummary = {
	tools: [
		{ name: "bash", args: { command: "npm test" }, durationMs: 8400 },
		{ name: "read", args: { path: "/x" }, inflight: true },
	],
	lastText: "done\nsecond line",
};
const inspBase = { wave: "w", eventsPath: "/w/w-a.events.jsonl", errPath: "/w/w-a.err", trace: inspTrace };
check(
	"inspector settled+artifact: header, trace with durations/in-flight, artifact link and full content",
	(() => {
		const out = formatLaneInspector({ ...inspBase, status: st({ state: "settled", stopReason: "stop", model: "zai/glm-4.6", thinkingLevel: "high", turns: 3, lastEventAgeSec: 5 }), artifact: { path: "/w/w-a.md", content: "the answer\n" } }, (p) => `<${p}>`);
		return (
			out.startsWith("lane 'lane' in wave 'w' — settled") &&
			out.includes("glm-4.6 think:high · 3 turns · tok 10in/2out · $0.0010 · stop:stop") &&
			out.includes("bash {\"command\":\"npm test\"} — 8.4s") &&
			out.includes("read {\"path\":\"/x\"} — in flight") &&
			out.includes("artifact: </w/w-a.md> (11 B)") &&
			out.includes("    the answer")
		);
	})(),
);
check(
	"inspector settled uncollected: last-text preview and the not-yet-collected line",
	(() => {
		const out = formatLaneInspector({ ...inspBase, status: st({ state: "settled", stopReason: "stop" }) }, (p) => p);
		return out.includes("last text: done second line") && out.includes("artifact: not yet collected");
	})(),
);
check(
	"inspector failed: cause in the header, err tail indented, transcript/err paths, no artifact line",
	(() => {
		const out = formatLaneInspector({ ...inspBase, status: st({ state: "failed", cause: "crashed", errTail: "boom\nline2" }) }, (p) => `<${p}>`);
		return (
			out.startsWith("lane 'lane' in wave 'w' — failed (crashed)") &&
			out.includes("  err: boom\n    line2") &&
			out.includes("transcript: </w/w-a.events.jsonl> · err: </w/w-a.err>") &&
			!out.includes("artifact:")
		);
	})(),
);
check(
	"inspector running: no settled/failed-only bits, empty trace renders nothing, preview present when text exists",
	(() => {
		const noTools = formatLaneInspector({ ...inspBase, status: st({}), trace: { tools: [], lastText: "" } }, (p) => p);
		const withText = formatLaneInspector({ ...inspBase, status: st({}) }, (p) => p);
		return !noTools.includes("trace:") && !noTools.includes("last text") && withText.includes("last text: done second line");
	})(),
);

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
