/**
 * pi-minimal-dispatch configuration.
 *
 * Precedence (later wins): built-in defaults < `<agent-dir>/pi-minimal-dispatch.json`
 * < `.pi/pi-minimal-dispatch.json` < tool-call parameters.
 * The agent directory follows `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type DispatchConfig = {
	/** Default wave directory; the `workDir` tool parameter overrides. */
	workDir: string;
	/** Default lane deadline (seconds); the per-lane `deadlineSec` overrides. Minimum 1. */
	deadlineSec: number;
	/** Milliseconds between SIGTERM and SIGKILL in the `kill` action. Minimum 100. */
	killGraceMs: number;
	/** Statusbar poll interval in milliseconds. Minimum 100. */
	pollMs: number;
	/** Lane binary, resolved from PATH. */
	piBin: string;
	/** Deadline-leash binary (GNU coreutils `timeout`, or e.g. `gtimeout`). */
	timeoutBin: string;
};

export const DEFAULT_CONFIG: DispatchConfig = {
	workDir: ".pi/work",
	deadlineSec: 900,
	killGraceMs: 5000,
	pollMs: 2000,
	piBin: "pi",
	timeoutBin: "timeout",
};

const CONFIG_NAME = "pi-minimal-dispatch.json";

/** Numeric floors guarding against degenerate values (instant kills, busy loops). */
const MINIMA: Partial<Record<keyof DispatchConfig, number>> = {
	deadlineSec: 1,
	killGraceMs: 100,
	pollMs: 100,
};

function readConfigFile(file: string): Record<string, unknown> {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e: any) {
		if (e.code === "ENOENT") return {};
		throw e;
	}
	if (raw.trim() === "") return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e: any) {
		throw new Error(`invalid JSON in ${file}: ${e.message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`invalid config in ${file}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

function applyOverrides(cfg: DispatchConfig, overrides: Record<string, unknown>, source: string): DispatchConfig {
	const known = new Set(Object.keys(DEFAULT_CONFIG));
	for (const [key, value] of Object.entries(overrides)) {
		if (!known.has(key)) {
			throw new Error(`unknown config key '${key}' in ${source} — valid keys: ${[...known].join(", ")}`);
		}
		const minimum = MINIMA[key as keyof DispatchConfig];
		if (minimum !== undefined) {
			if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) {
				throw new Error(`config key '${key}' in ${source} must be an integer >= ${minimum}, got ${JSON.stringify(value)}`);
			}
		} else if (typeof value !== "string" || value === "") {
			throw new Error(`config key '${key}' in ${source} must be a non-empty string, got ${JSON.stringify(value)}`);
		}
		(cfg as Record<string, unknown>)[key] = value;
	}
	return cfg;
}

/**
 * Load the effective configuration: defaults, then user file, then project file.
 * Throws with the offending file path and valid choices on any invalid input.
 */
export function loadConfig(projectRoot: string = process.cwd()): DispatchConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	let cfg = { ...DEFAULT_CONFIG };
	cfg = applyOverrides(cfg, readConfigFile(path.join(agentDir, CONFIG_NAME)), path.join(agentDir, CONFIG_NAME));
	cfg = applyOverrides(cfg, readConfigFile(path.join(projectRoot, ".pi", CONFIG_NAME)), path.join(projectRoot, ".pi", CONFIG_NAME));
	return cfg;
}
