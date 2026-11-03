/**
 * Unit tests for src/format.ts — presentation formatters from README.md.
 * Run: node tests/format.test.ts
 */

import type { LaneStatus } from "../src/derive.ts";
import { formatCollectEntry, formatInlineArtifact, formatLaneLine, formatStatusBarSummary, suspectOf } from "../src/format.ts";

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
	"statusbar: done buckets in stable sorted order (failed before settled)",
	formatStatusBarSummary([st({ state: "settled" }), st({ state: "running" }), st({ state: "failed", cause: "crashed", name: "d" })]) === "lanes: 1 running · 1 failed · 1 settled",
);
check(
	"statusbar: nothing in flight → undefined (clear)",
	formatStatusBarSummary([st({ state: "settled" }), st({ state: "failed", cause: "deadline", name: "b" })]) === undefined && formatStatusBarSummary([]) === undefined,
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

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
