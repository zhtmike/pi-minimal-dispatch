/**
 * pi-minimal-dispatch — detached lane dispatch with visible state (README.md).
 * `dispatch`: spawn a wave of detached `timeout … pi --mode json …` lanes, return immediately.
 * `lanes`: stateless status/kill/collect over the wave's manifest + event streams.
 * The lane protocol is fixed (`--mode json --no-session -ns`); every variable
 * knob is configurable (docs/API.md → Configuration).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DispatchConfig, loadConfig } from "./config.ts";
import {
	type LaneRecord,
	type LaneStatus,
	type Manifest,
	deriveLane,
	finalAssistantText,
	manifestPathFor,
	parseEvents,
	pidAlive,
	psLstart,
	readManifest,
	writeManifestAtomic,
} from "./derive.ts";
import { formatStatusBarSummary, formatWaveStatus } from "./format.ts";
import { type LaneParams, assertLaneTools, assertSlugs, buildLaneArgs, laneEnv, missingBriefs, resolveExecutable, selectKillTargets } from "./lane.ts";

/** Spawn one lane detached; a failure at any step becomes the record's spawnError, never a throw. */
function spawnLane(workDir: string, wave: string, lane: LaneParams, cfg: DispatchConfig, timeoutBin: string): LaneRecord {
	const briefPath = path.resolve(lane.briefPath);
	const record: LaneRecord = {
		name: lane.name,
		briefPath,
		eventsPath: path.join(workDir, `${wave}-${lane.name}.events.jsonl`),
		errPath: path.join(workDir, `${wave}-${lane.name}.err`),
		pid: null,
		processStart: null,
		startedAt: new Date().toISOString(),
		deadlineSec: lane.deadlineSec ?? cfg.deadlineSec,
		model: lane.model,
		tools: lane.tools,
		spawned: false,
	};

	let outFd = -1;
	let errFd = -1;
	try {
		outFd = fs.openSync(record.eventsPath, "w");
		errFd = fs.openSync(record.errPath, "w");
		const args = [
			timeoutBin,
			...buildLaneArgs(lane, cfg, record.deadlineSec, Math.ceil(cfg.killGraceMs / 1000)),
		];
		const child = spawn(args[0], args.slice(1), {
			detached: true, // own process group; survives this process's exit
			stdio: ["ignore", outFd, errFd],
			env: laneEnv(),
		});
		child.unref();
		child.on("error", (e) => {
			// Async spawn failure lands after we returned; the cause goes to .err
			try {
				fs.appendFileSync(record.errPath, `\n[pi-minimal-dispatch] spawn error: ${e.message}\n`);
			} catch {}
		});
		record.pid = child.pid;
		const start = psLstart(child.pid!);
		if (start === "") {
			// Without a start-time the liveness guard can never match — stop the lane
			// now rather than record an unmatchable identity.
			try {
				process.kill(-child.pid!, "SIGTERM");
			} catch {}
			record.spawnError = "could not capture process start-time (ps failed); lane terminated";
		} else {
			record.processStart = start;
			record.spawned = true;
		}
	} catch (e: any) {
		record.spawnError = e.message;
	} finally {
		if (outFd !== -1) fs.closeSync(outFd);
		if (errFd !== -1) fs.closeSync(errFd);
	}
	return record;
}

const dispatchTool = defineTool({
	name: "dispatch",
	label: "Dispatch lanes",
	description:
		"Spawn detached sub-agent lanes (fresh pi processes) for a wave and return immediately. Each lane runs " +
		"`timeout -k <graceSec> <deadlineSec> pi --mode json --no-session -ns [flags] @<briefPath>` in its own " +
		"process group, streaming JSON events to <workDir>/<wave>-<name>.events.jsonl. Lanes survive this " +
		"session's exit. Write briefs first — one brief file per lane is the lane's entire prompt; " +
		"lanes run in fresh processes (JSON event mode, no session) with skills unloaded (-ns), " +
		"a read-only tool default, MCP reach only via a route named in tools (else set mcp: false), " +
		"and never the dispatch tool itself. Every lane in the call is " +
		"spawned — the caller bounds the wave. " +
		"Then poll with the lanes tool; collect artifacts when settled.",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug (kebab-case, max 64 chars); must not already exist in workDir" }),
		lanes: Type.Array(
			Type.Object({
				name: Type.String({ description: "Lane slug (kebab-case, max 64 chars, unique within the wave)" }),
				briefPath: Type.String({ description: "Path to the lane's brief file (@file prompt)" }),
				model: Type.Optional(Type.String({ description: "Pin a model id for this lane; omitted: pi's configured default model — not necessarily the dispatcher session's active model" })),
				deadlineSec: Type.Optional(Type.Number({ description: "Deadline leash in seconds (config default: 900)", minimum: 1 })),
				tools: Type.Optional(Type.String({ description: "Tool allowlist for --tools; omitted: 'read,grep,find,ls' — add 'bash' when a lane must run commands (bash can still invoke git). Plain names or mcp__/tool patterns only: +name/-name modifiers, shell quoting, and empty lists are rejected. With mcp enabled, MCP/web tools are reachable only through 'codemode' or 'tool_search' named here ('mcp__server__*' entries declare tools directly only for direct-exposure servers)" })),
				noExtensions: Type.Optional(Type.Boolean({ description: "Pass -ne (drop extensions incl. MCP)" })),
				mcp: Type.Optional(Type.Boolean({ description: "Set false to pass --no-mcp (no MCP servers connect). Servers connecting alone grants no reach: with mcp enabled, tools must name 'codemode' or 'tool_search' or dispatch rejects the lane" })),
			}),
			{ minItems: 1 },
		),
		workDir: Type.Optional(Type.String({ description: "Directory for briefs/events/manifest (config default: .pi/work)" })),
	}),

	async execute(_id, params) {
		const cfg = loadConfig();
		const workDir = path.resolve(params.workDir ?? cfg.workDir);
		fs.mkdirSync(workDir, { recursive: true });
		// Slugs are validated before the manifest claim: a post-claim throw would strand the slug.
		assertSlugs(params.wave, params.lanes.map((l) => l.name));

		// All briefs must exist before anything spawns: report every missing one.
		const missing = missingBriefs(params.lanes);
		if (missing.length > 0) {
			throw new Error(`brief file(s) not found: ${missing.join(", ")} — nothing spawned`);
		}

		// Tool contracts are validated before the manifest claim: a post-claim throw would strand the slug.
		assertLaneTools(params.lanes);

		// Claim the wave slug atomically; an existing manifest rejects it.
		const manifestPath = manifestPathFor(workDir, params.wave);
		let claimFd: number;
		try {
			claimFd = fs.openSync(manifestPath, "wx");
		} catch (e: any) {
			if (e.code === "EEXIST") throw new Error(`wave '${params.wave}' already exists (${manifestPath})`);
			throw e;
		}

		let timeoutBin: string;
		try {
			timeoutBin = resolveExecutable(cfg.timeoutBin);
			resolveExecutable(cfg.piBin);
		} catch (e) {
			fs.closeSync(claimFd);
			fs.unlinkSync(manifestPath);
			throw e;
		}

		const manifest: Manifest = {
			version: 1,
			wave: params.wave,
			workDir,
			createdAt: new Date().toISOString(),
			lanes: [],
		};
		for (const lane of params.lanes) {
			manifest.lanes.push(spawnLane(workDir, params.wave, lane, cfg, timeoutBin));
		}

		try {
			fs.writeSync(claimFd, JSON.stringify(manifest, null, "\t"));
			fs.closeSync(claimFd);
		} catch (e) {
			// environmental failure after the claim: free the slug and stop already-spawned lanes
			for (const l of manifest.lanes) {
				if (l.pid !== null) {
					try {
						process.kill(-l.pid, "SIGTERM");
					} catch {}
				}
			}
			try {
				fs.closeSync(claimFd);
			} catch {}
			fs.unlinkSync(manifestPath);
			throw e;
		}
		trackWave(params.wave, workDir);

		const lines = manifest.lanes.map(
			(l) =>
				`  ${l.name}: ${l.spawned ? `pid ${l.pid} (deadline ${l.deadlineSec}s)` : `SPAWN ERROR: ${l.spawnError}`}`,
		);
		return {
			content: [
				{
					type: "text",
					text: `wave '${params.wave}' dispatched — ${manifest.lanes.filter((l) => l.spawned).length}/${manifest.lanes.length} lanes spawned\n${lines.join("\n")}\nmanifest: ${manifestPath}`,
				},
			],
			structuredContent: { wave: params.wave, manifestPath, lanes: manifest.lanes },
			details: { manifestPath },
		};
	},
});

const lanesTool = defineTool({
	name: "lanes",
	label: "Lane status",
	description:
		"Observe/control a dispatched wave. action=status (default): per-lane derived state " +
		"(starting/running/settled/failed + cause spawn|killed|deadline|crashed), turns, run-total usage, " +
		"stopReason, last-event age, .err tail for crashed lanes. action=kill: SIGTERM the lane process group " +
		"(SIGKILL after the configured grace), start-time guarded. action=collect: write each finished lane's final assistant " +
		"message to <wave>-<name>.md (suspect-flagged on failure/empty/non-clean stopReason); a refusal " +
		"(running / never spawned) is a successful result with a per-lane reason. Stateless: reads the manifest " +
		"fresh — works across sessions, including after the dispatcher exited. A collected lane is a path plus " +
		"`suspect`; `suspect: true` means the artifact is not done — read the file only to judge it, do not paste " +
		"it back. Discover waves: ls <workDir>/*-manifest.json.",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug" }),
		action: Type.Optional(StringEnum(["status", "kill", "collect"])),
		workDir: Type.Optional(Type.String({ description: "Directory holding the manifest (config default: .pi/work)" })),
	}),

	async execute(_id, params, signal) {
		const cfg = loadConfig();
		const workDir = path.resolve(params.workDir ?? cfg.workDir);
		const action = params.action ?? "status";
		const manifest = readManifest(workDir, params.wave);
		trackWave(params.wave, workDir);

		if (action === "status") {
			const now = Date.now();
			const statuses = manifest.lanes.map((l) => deriveLane(l, now));
			return {
				content: [{ type: "text", text: formatWaveStatus(params.wave, statuses) }],
				structuredContent: { wave: params.wave, lanes: statuses },
				details: { wave: params.wave },
			};
		}

		if (action === "kill") {
			const killed: string[] = [];
			try {
				const targets = selectKillTargets(
					manifest.lanes,
					(l) => pidAlive(l.pid!, l.processStart), // never signal a reused PID
					(l) => deriveLane(l, Date.now()).state === "settled",
				);
				for (const lane of targets) {
					try {
						process.kill(-lane.pid!, "SIGTERM"); // negative = process group (timeout + pi)
					} catch (e: any) {
						if (e.code === "ESRCH") continue;
						throw e;
					}
					killed.push(lane.name);
					lane.killedAt = new Date().toISOString(); // tombstone
				}
			} catch (e) {
				writeManifestAtomic(manifest); // a throw mid-loop must not lose already-stamped tombstones
				throw e;
			}
			if (killed.length > 0) {
				const deadline = Date.now() + cfg.killGraceMs;
				while (Date.now() < deadline) {
					if (signal?.aborted) break;
					await new Promise((r) => setTimeout(r, 200));
					const survivors = manifest.lanes.filter(
						(l) => l.killedAt !== undefined && l.pid !== null && pidAlive(l.pid, l.processStart),
					);
					if (survivors.length === 0) break;
					if (Date.now() + 200 >= deadline) {
						for (const l of survivors) {
							try {
								process.kill(-l.pid!, "SIGKILL");
							} catch {}
						}
					}
				}
				writeManifestAtomic(manifest);
			}
			const statuses = manifest.lanes.map((l) => deriveLane(l, Date.now()));
			return {
				content: [
					{
						type: "text",
						text:
							`killed: ${killed.length ? killed.join(", ") : "none (nothing eligible)"}\n` +
							statuses.map((s) => `  ${s.name}: ${s.state}${s.cause ? ` (${s.cause})` : ""}`).join("\n"),
					},
				],
				structuredContent: { wave: params.wave, killed, lanes: statuses },
				details: { wave: params.wave },
			};
		}

		// action === "collect"
		const results: Array<{ name: string; artifact?: string; suspect?: boolean; reason?: string; stopReason?: string }> = [];
		for (const lane of manifest.lanes) {
			const status = deriveLane(lane, Date.now());
			if (status.cause === "spawn") {
				results.push({ name: lane.name, reason: "never spawned — refused" });
				continue;
			}
			if (status.state === "running" || status.state === "starting") {
				results.push({ name: lane.name, reason: "still running — refused" });
				continue;
			}
			const text = finalAssistantText(parseEvents(lane.eventsPath));
			const suspect = status.state === "failed" || text === "" || status.stopReason !== "stop";
			const artifact = path.join(workDir, `${params.wave}-${lane.name}.md`);
			fs.writeFileSync(artifact, text.endsWith("\n") || text === "" ? text : text + "\n");
			results.push({ name: lane.name, artifact, suspect, stopReason: status.stopReason });
		}
		const text = results
			.map((r) => `  ${r.name}: ${r.artifact ?? r.reason}${r.suspect ? " [SUSPECT]" : ""}${r.stopReason !== undefined ? ` stop:${r.stopReason}` : ""}`)
			.join("\n");
		return {
			content: [{ type: "text", text: `collect wave '${params.wave}':\n${text}` }],
			structuredContent: { wave: params.wave, results },
			details: { wave: params.wave },
		};
	},
});

// --- statusbar tracking (in-memory cache; manifest and event files stay authoritative) ---

const STATUS_KEY = "pi-minimal-dispatch";

type UiCtx = { mode: string; ui: { setStatus(key: string, text: string | undefined): void } };

const tracked = new Map<string, string>(); // wave -> workDir
let pollTimer: ReturnType<typeof setInterval> | null = null;
let uiCtx: UiCtx | null = null;

function statusBarTick(): void {
	const ctx = uiCtx;
	if (ctx === null) return;
	const all: LaneStatus[] = [];
	for (const [wave, workDir] of tracked) {
		if (!fs.existsSync(manifestPathFor(workDir, wave))) {
			tracked.delete(wave); // the wave was cleaned up
			continue;
		}
		try {
			const m = readManifest(workDir, wave);
			all.push(...m.lanes.map((l) => deriveLane(l, Date.now())));
		} catch {
			// corrupt manifest/events: skipped this tick — /lanes and the lanes tool surface the error loudly
		}
	}
	const summary = formatStatusBarSummary(all);
	if (summary === undefined) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		stopPolling();
	} else {
		ctx.ui.setStatus(STATUS_KEY, summary);
	}
}

function armPolling(): void {
	if (pollTimer === null && tracked.size > 0 && uiCtx !== null && (uiCtx.mode === "tui" || uiCtx.mode === "rpc")) {
		pollTimer = setInterval(statusBarTick, loadConfig().pollMs);
	}
}

function trackWave(wave: string, workDir: string): void {
	tracked.set(wave, workDir);
	armPolling();
}

function stopPolling(): void {
	if (pollTimer !== null) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
}

export default function (pi: ExtensionAPI) {
	// A dispatched lane never gets the dispatch tool again — the child marker
	// keeps this extension out of the lane while the rest of the user's setup loads.
	if (process.env.PI_MINIMAL_DISPATCH_CHILD === "1") return;

	pi.registerTool(dispatchTool);
	pi.registerTool(lanesTool);

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		// session replacement (new/resume/fork) keeps module state: re-arm if waves are still in flight
		armPolling();
	});

	pi.on("session_shutdown", () => {
		stopPolling();
	});

	pi.registerCommand("lanes", {
		description: "Show dispatched lane status — /lanes [wave]",
		getArgumentCompletions: (prefix) => {
			const hits = [...tracked.keys()].filter((w) => w.startsWith(prefix));
			return hits.length > 0 ? hits.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args, ctx) => {
			const show = (wave: string, workDir: string) =>
				ctx.ui.notify(formatWaveStatus(wave, readManifest(workDir, wave).lanes.map((l) => deriveLane(l, Date.now()))), "info");
			try {
				const wave = args.trim();
				if (wave === "") {
					if (tracked.size === 0) {
						ctx.ui.notify("no waves tracked this session", "info");
						return;
					}
					for (const [w, workDir] of tracked) {
						try {
							show(w, workDir);
						} catch {
							// a vanished manifest must not hide the remaining waves
						}
					}
					return;
				}
				show(wave, tracked.get(wave) ?? path.resolve(loadConfig().workDir));
			} catch (e: any) {
				ctx.ui.notify(e.message, "error");
			}
		},
	});
}
