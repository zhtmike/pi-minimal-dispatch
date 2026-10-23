/**
 * Unit tests for src/config.ts — precedence and validation.
 * Run: node tests/config.test.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.ts";

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-dispatch-cfg-"));
const agentDir = path.join(tmp, "agent");
const project = path.join(tmp, "project");
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(project, { recursive: true });
const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

check("defaults when no config files exist", JSON.stringify(loadConfig(project)) === JSON.stringify(DEFAULT_CONFIG));

fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), JSON.stringify({ deadlineSec: 300, piBin: "gtimeout" }));
let cfg = loadConfig(project);
check("user file merges over defaults", cfg.deadlineSec === 300 && cfg.piBin === "gtimeout" && cfg.pollMs === DEFAULT_CONFIG.pollMs);

fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
fs.writeFileSync(path.join(project, ".pi/pi-minimal-dispatch.json"), JSON.stringify({ deadlineSec: 60, workDir: "custom/work" }));
cfg = loadConfig(project);
check("project file overrides user file", cfg.deadlineSec === 60 && cfg.workDir === "custom/work" && cfg.piBin === "gtimeout");

fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), JSON.stringify({ bogus: 1 }));
check(
	"unknown key errors naming the file",
	throwsWith(() => loadConfig(project), "unknown config key 'bogus'"),
);
fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), JSON.stringify({ deadlineSec: 0 }));
check("deadlineSec below minimum errors", throwsWith(() => loadConfig(project), "deadlineSec"));
fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), JSON.stringify({ pollMs: "fast" }));
check("non-integer numeric key errors", throwsWith(() => loadConfig(project), "pollMs"));
fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), JSON.stringify({ timeoutBin: "" }));
check("empty string key errors", throwsWith(() => loadConfig(project), "timeoutBin"));
fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), "{not json");
check("invalid JSON errors with the path", throwsWith(() => loadConfig(project), "invalid JSON"));
fs.writeFileSync(path.join(agentDir, "pi-minimal-dispatch.json"), "");
check("empty file is fine", loadConfig(project).deadlineSec === 60);

if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
