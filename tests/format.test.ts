/**
 * Unit tests for src/format.ts — presentation formatters from README.md.
 * Run: node tests/format.test.ts
 */

import type { LaneStatus } from "../src/derive.ts";
import { formatLaneLine, formatStatusBarSummary } from "../src/format.ts";

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
	formatLaneLine(st({ state: "failed", cause: "crashed", errTail: "boom\nsecond" })).includes("lane · failed · (crashed)") &&
		formatLaneLine(st({ state: "running", overdue: true })).includes("OVERDUE") &&
		formatLaneLine(st({ state: "running" })).includes("1 turn") &&
		formatLaneLine(st({ state: "running", turns: 2 })).includes("2 turns") &&
		formatLaneLine(st({ state: "failed", cause: "crashed", errTail: "boom" })).includes("\n    err: boom"),
);
check(
	"lane line: model tag after name, provider prefix dropped, thinking only when present",
	formatLaneLine(st({ model: "openrouter/zai/glm-4.6", thinkingLevel: "high" })).includes("lane [glm-4.6 think:high] · running") &&
		formatLaneLine(st({ model: "zai/glm-5.3-flash" })).includes("lane [glm-5.3-flash] · running") &&
		!formatLaneLine(st({})).includes("["),
);

console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
