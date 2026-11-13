/**
 * pi-minimal-dispatch — detached lane dispatch with visible state (README.md).
 * `dispatch`: spawn a wave of detached `timeout … pi --mode json …` lanes, return immediately.
 * `lanes`: stateless status/kill/collect over the wave's manifest + event streams.
 * The lane protocol is fixed (`--mode json --no-session -ns`); every variable
 * knob is configurable (docs/API.md → Configuration).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir, hostname } from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { defineTool, getMarkdownTheme, type AgentToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Host-aliased to pi's own copy (docs/packages.md) — never listed in dependencies.
import { getCapabilities, hyperlink, Markdown, Text } from "@earendil-works/pi-tui";
import { type DispatchConfig, loadConfig } from "./config.ts";
import {
	type LaneRecord,
	type Manifest,
	artifactPathFor,
	currentOwner,
	deriveLanes,
	deriveLane,
	deriveTrace,
	groupAlive,
	laneEvents,
	manifestPathFor,
	ownerGuard,
	parseEvents,
	pidAlive,
	psLstart,
	readManifest,
	releaseUnblocked,
	releaseWave,
	scanWaves,
	terminalState,
	unconsumedTranscripts,
	waitForTerminal,
	waveSlugsIn,
	waveTerminal,
	writeManifestAtomic,
} from "./derive.ts";
import {
	type CollectSnapshotEntry,
	type PathRenderer,
	type StatusBarEntry,
	collectSnapshotEntry,
	displayPath,
	dispatchNextHint,
	waitNextHint,
	collectNextHint,
	fileUri,
	formatCollectExpanded,
	formatCollectEntry,
	formatLaneInspector,
	formatStatusBarSummary,
	formatWaveHeader,
	formatWaveList,
	formatWaveStatus,
	formatWaveStatusTui,
	lanesUsageLine,
	plainPath,
	suspectOf,
} from "./format.ts";
import {
	type LaneParams,
	assertActionParams,
	assertBriefTools,
	assertLaneTools,
	assertSlugs,
	buildLaneArgs,
	defaultWaveOf,
	laneEnv,
	lanesCompletions,
	missingBriefs,
	missingBriefsError,
	parseLanesArgs,
	resolveExecutable,
	resolveLaneFilter,
	resolveWaitMode,
	selectKillTargets,
	waveClaimedError,
} from "./lane.ts";

/**
 * `Type.Unsafe` keeps the literal-union typing that `defineTool`'s TypeBox inference reads;
 * the emitted `{ type: "string", enum: [...] }` matches pi-ai's `StringEnum`.
 */
function stringEnum<T extends readonly string[]>(values: T, options?: { description?: string }) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...(options?.description ? { description: options.description } : {}) });
}

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
		thinking: lane.thinking,
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
		record.pid = child.pid ?? null;
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
		"Spawn detached sub-agent lanes (fresh pi processes) for a wave and return immediately; " +
		"lanes survive this session's exit, and every lane in the call is spawned — no queueing. " +
		"One brief file per lane is that lane's entire prompt — write briefs first; a lane sees nothing else: " +
		"no skills, no session context, read-only tools unless granted more, never the dispatch tool. " +
		"The workDir is shared across sessions — park briefs under a per-session subdirectory (e.g. `.pi/work/s/<session-id>/`). " +
		"Then wait (lanes action='wait'), collect artifacts when settled, release the wave when done.",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug" }),
		lanes: Type.Array(
			Type.Object({
				name: Type.String({ description: "Lane slug" }),
				briefPath: Type.String({ description: "Path to the lane's brief file (@file prompt)" }),
				model: Type.Optional(Type.String({ description: "Pin a model id, pi's id:thinking suffix allowed; omitted: pi's configured default — not necessarily this session's active model" })),
				thinking: Type.Optional(stringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], { description: "Pin a thinking level; wins over model's :level suffix — status reports the actual level" })),
				deadlineSec: Type.Optional(Type.Number({ description: "Deadline leash in seconds (config default: 900)", minimum: 1 })),
				tools: Type.Optional(Type.String({ description: "Tool allowlist, comma-separated; default 'read,grep,find,ls' (read-only — grant 'bash' only with cause)" })),
				noExtensions: Type.Optional(Type.Boolean({ description: "Pass -ne (drop extensions incl. MCP)" })),
				mcp: Type.Optional(Type.Boolean({ description: "false: no MCP servers connect" })),
			}),
			{ minItems: 1 },
		),
		workDir: Type.Optional(Type.String({ description: "Directory for briefs/events/manifest (config default: .pi/work)" })),
	}),

	async execute(_id, params, _signal, _onUpdate, ctx) {
		const cfg = loadConfig();
		const workDir = path.resolve(params.workDir ?? cfg.workDir);
		fs.mkdirSync(workDir, { recursive: true });
		// Owner identity is captured before anything validates: a blind ps would make
		// every later release/kill guard fail closed forever.
		const owner = currentOwner(ctx.sessionManager.getSessionId());
		// Slugs are validated before the manifest claim: a post-claim throw would strand the slug.
		assertSlugs(params.wave, params.lanes.map((l) => l.name));

		// All briefs must exist before anything spawns: report every missing one.
		const missing = missingBriefs(params.lanes);
		if (missing.length > 0) {
			throw new Error(missingBriefsError(missing));
		}

		// Tool contracts are validated before the manifest claim: a post-claim throw would strand the slug.
		assertLaneTools(params.lanes);
		// A brief that demands a shell the lane lacks fails here, not mid-run after spawn.
		assertBriefTools(params.lanes);

		// Claim the wave slug atomically; an existing manifest rejects it.
		const manifestPath = manifestPathFor(workDir, params.wave);
		let claimFd: number;
		try {
			claimFd = fs.openSync(manifestPath, "wx");
		} catch (e: any) {
			if (e.code === "EEXIST") throw new Error(waveClaimedError(params.wave, manifestPath));
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
			owner,
			lanes: [],
		};
		for (const lane of params.lanes) {
			manifest.lanes.push(spawnLane(workDir, params.wave, lane, cfg, timeoutBin));
		}

		try {
			// The wx claim was only the lock; the content lands by atomic rename so a
			// concurrent reader never sees a half-written manifest.
			fs.closeSync(claimFd);
			writeManifestAtomic(manifest);
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
					text: `wave '${params.wave}' dispatched — ${manifest.lanes.filter((l) => l.spawned).length}/${manifest.lanes.length} lanes spawned\n${lines.join("\n")}\nmanifest: ${manifestPath}\n${dispatchNextHint(params.wave)}`,
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
		"Observe/control a dispatched wave — stateless, works across sessions (reads the manifest fresh, even after the dispatcher exited). " +
		"action=status (default): per-lane state (starting/running/settled/failed), turns, usage, model, stopReason. " +
		"action=wait: hold open until every lane settles or any fails (waitSec caps it) — replaces status-poll sleeps. " +
		"action=kill: stop lanes (SIGTERM, escalating to SIGKILL). " +
		"action=collect: write each finished lane's final message to an artifact; `suspect: true` means not done — judge it, don't paste it back. " +
		"action=release: delete the wave's own files. " +
		"Never hand-delete workDir contents while a lane may still be running — consume waves instead (collect, then release).",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug" }),
		action: Type.Optional(stringEnum(["status", "wait", "kill", "collect", "release"])),
		lane: Type.Optional(
			Type.Array(Type.String(), {
				minItems: 1,
				description: "Target only these lanes",
			}),
		),
		waitMode: Type.Optional(
			stringEnum(["all", "hold", "any"], { description: "'all' (default): every lane settled or any failed · 'hold': sit out known failures until all lanes are terminal · 'any': return at the first terminal lane" }),
		),
		waitSec: Type.Optional(Type.Number({ description: "wait action only: max seconds to hold the call open (default 300; 1–3600)", minimum: 1, maximum: 3600 })),
		inlineMaxBytes: Type.Optional(
			Type.Integer({
				minimum: 0,
				description: "inline each non-suspect artifact's content when it fits in N bytes (default 0 — never inline)",
			}),
		),
		workDir: Type.Optional(Type.String({ description: "Directory holding the manifest (config default: .pi/work)" })),
	}),

	async execute(_id, params, signal, _onUpdate, ctx): Promise<AgentToolResult<{ wave: string; snapshot?: CollectSnapshotEntry[] }>> {
		const cfg = loadConfig();
		const workDir = path.resolve(params.workDir ?? cfg.workDir);
		const action = params.action ?? "status";
		// Compatibility before slug validation: a misplaced parameter is the caller's
		// first fix; the manifest is only needed to check the slugs against.
		assertActionParams(action, params);
		const manifest = readManifest(workDir, params.wave);
		trackWave(params.wave, workDir);

		if (action === "status") {
			const now = Date.now();
			const statuses = deriveLanes(manifest.lanes, now);
			return {
				content: [{ type: "text", text: formatWaveStatus(params.wave, statuses) }],
				structuredContent: { wave: params.wave, lanes: statuses },
				details: { wave: params.wave },
			};
		}

		if (action === "wait") {
			// A timeout is a normal status result with running lanes, never an error.
			const statuses = await waitForTerminal(workDir, params.wave, (params.waitSec ?? 300) * 1000, cfg.pollMs, signal, resolveWaitMode(params.waitMode));
			// The hint chains the workflow only when nothing is left to wait for.
			return {
				content: [{ type: "text", text: formatWaveStatus(params.wave, statuses) + (statuses.every(terminalState) ? `\n${waitNextHint(params.wave)}` : "") }],
				structuredContent: { wave: params.wave, lanes: statuses },
				details: { wave: params.wave },
			};
		}

		if (action === "kill") {
			const filterLanes = resolveLaneFilter(manifest.lanes, params.lane);
			const filterNames = filterLanes === undefined ? undefined : new Set(filterLanes.map((l) => l.name));
			const guard = ownerGuard(manifest.owner, ctx.sessionManager.getSessionId(), hostname(), params.wave);
			if (!guard.ok) throw new Error(guard.reason);
			const killed: string[] = [];
			const settled = new Set(deriveLanes(manifest.lanes, Date.now()).filter((s) => s.state === "settled").map((s) => s.name));
			const targets = selectKillTargets(
				manifest.lanes,
				(l) => pidAlive(l.pid!, l.processStart), // never signal a reused PID
				(l) => settled.has(l.name),
				filterNames,
			);
			try {
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
				// The leash watches the process GROUP: the timeout leader may die on SIGTERM
				// while a TERM-immune member lingers — leader-pid liveness would end the grace early.
				const deadline = Date.now() + cfg.killGraceMs;
				for (;;) {
					const survivors = targets.filter((l) => l.killedAt !== undefined && l.pid !== null && groupAlive(l.pid));
					if (survivors.length === 0) break;
					// Cancellation stops the waiting, not the kill — escalate at once, never
					// abandon a half-killed lane with a tombstone claiming it died.
					if (signal?.aborted || Date.now() + 200 >= deadline) {
						for (const l of survivors) {
							try {
								process.kill(-l.pid!, "SIGKILL");
							} catch {}
						}
						break;
					}
					await new Promise((r) => setTimeout(r, 200));
				}
				writeManifestAtomic(manifest);
			}
			const statuses = (filterLanes ?? manifest.lanes).map((l) => deriveLane(l, Date.now()));
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

		if (action === "release") {
			const guard = ownerGuard(manifest.owner, ctx.sessionManager.getSessionId(), hostname(), params.wave);
			if (!guard.ok) throw new Error(guard.reason);
			if (!waveTerminal(manifest.lanes, Date.now())) {
				throw new Error(`wave '${params.wave}' is not settled — wait or kill first`);
			}
			const unconsumed = unconsumedTranscripts(manifest);
			if (unconsumed.length > 0) {
				throw new Error(
					`wave '${params.wave}' has unconsumed lane transcripts (${unconsumed.join(", ")}) — collect first; a human may clean up by hand`,
				);
			}
			const { deleted, absent } = releaseWave(manifest);
			tracked.delete(params.wave); // the wave is gone; do not wait for the next statusbar tick
			return {
				content: [
					{
						type: "text",
						text: `released wave '${params.wave}': ${deleted.length} file(s) deleted, ${absent} already absent`,
					},
				],
				structuredContent: { wave: params.wave, deleted, absent },
				details: { wave: params.wave },
			};
		}

		// action === "collect"
		const collectScope = resolveLaneFilter(manifest.lanes, params.lane) ?? manifest.lanes;
		const inlineMaxBytes = params.inlineMaxBytes ?? 0;
		const results: Array<{ name: string; artifact?: string; suspect?: boolean; suspectCause?: string; reason?: string; stopReason?: string }> = [];
		const contents = new Map<string, string>(); // display-only: artifact content never enters structuredContent
		const snapshot: CollectSnapshotEntry[] = []; // details-only: the expanded TUI block renders this, never disk
		const collectStatuses = deriveLanes(collectScope, Date.now());
		for (const [i, lane] of collectScope.entries()) {
			const status = collectStatuses[i];
			if (status.cause === "spawn") {
				results.push({ name: lane.name, reason: "never spawned — refused" });
				continue;
			}
			if (status.state === "running" || status.state === "starting") {
				results.push({ name: lane.name, reason: "still running — refused" });
				continue;
			}
			// A corrupt transcript collects an empty suspect artifact — the wave stays releasable.
			let text = "";
			try {
				text = laneEvents(lane.eventsPath).fold.lastText;
			} catch {}
			const { suspect, cause } = suspectOf(status, text);
			const artifact = artifactPathFor(manifest, lane);
			const written = text.endsWith("\n") || text === "" ? text : text + "\n";
			fs.writeFileSync(artifact, written);
			results.push({ name: lane.name, artifact, suspect, suspectCause: cause, stopReason: status.stopReason });
			contents.set(lane.name, written);
			snapshot.push(collectSnapshotEntry(lane.name, artifact, written));
		}
		// The hint names release exactly when release would not refuse — wave
		// preconditions plus the ownership guard, never this call's scope alone.
		const releaseHintOk =
			ownerGuard(manifest.owner, ctx.sessionManager.getSessionId(), hostname(), params.wave).ok &&
			releaseUnblocked(manifest, Date.now());
		const text =
			results.map((r) => formatCollectEntry({ ...r, content: contents.get(r.name) }, inlineMaxBytes)).join("\n") +
			(releaseHintOk ? `\n${collectNextHint(params.wave)}` : "");
		return {
			content: [{ type: "text", text: `collect wave '${params.wave}':\n${text}` }],
			structuredContent: { wave: params.wave, results },
			details: { wave: params.wave, snapshot },
		};
	},
	// Collect results only: every other action throws through to the host's own default
	// rendering, and the collapsed state is the collect text as-is.
	renderResult(result, options, theme) {
		const snapshot = result.details?.snapshot;
		if (snapshot === undefined) throw new Error("not a collect result");
		if (!options.expanded) {
			const body = result.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
			return new Text(theme.fg("toolOutput", body), 0, 0);
		}
		return new Markdown(formatCollectExpanded(snapshot), 0, 0, getMarkdownTheme());
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
	const tagged: Array<{ lane: LaneRecord; wave: string }> = [];
	for (const [wave, workDir] of tracked) {
		if (!fs.existsSync(manifestPathFor(workDir, wave))) {
			tracked.delete(wave); // the wave was cleaned up
			continue;
		}
		try {
			const m = readManifest(workDir, wave);
			// wave-tagged so the footer can name the lone running lane
			tagged.push(...m.lanes.map((l) => ({ lane: l, wave: m.wave })));
		} catch {
			// corrupt manifest: skipped this tick — events fail soft into the table;
			// /lanes and the lanes tool surface the error loudly
		}
	}
	// one derive sweep — one ps probe for every tracked wave's lanes, not one per lane
	const statuses = deriveLanes(tagged.map((t) => t.lane), Date.now());
	const all: StatusBarEntry[] = statuses.map((s, i) => ({ ...s, wave: tagged[i].wave }));
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

/** The scanned set: the default workDir plus every tracked wave's workDir — a custom-dir wave stays listed. */
function scanDirs(): string[] {
	return [...new Set([path.resolve(loadConfig().workDir), ...tracked.values()])];
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
		description: "Inspect waves/lanes — /lanes [wave] [lane]",
		getArgumentCompletions: (arg) => {
			// Filenames only for level 1 — no derivation on the keystroke path.
			const dirs = scanDirs();
			const slugs = [...new Set(dirs.flatMap((d) => waveSlugsIn(d)))];
			return lanesCompletions(arg, slugs, (wave) => {
				const dir = tracked.get(wave) ?? dirs.find((d) => fs.existsSync(manifestPathFor(d, wave)));
				if (dir === undefined) return [];
				try {
					return readManifest(dir, wave).lanes.map((l) => l.name);
				} catch {
					return [];
				}
			});
		},
		handler: async (args, ctx) => {
			// The real gate (PI_HYPERLINKS, tmux probe) — plain paths wherever the terminal can't link.
			const links = getCapabilities().hyperlinks;
			const renderPath: PathRenderer = (p) =>
				links ? hyperlink(displayPath(p, ctx.cwd), fileUri(p)) : plainPath(p, homedir());
			try {
				const { wave: parsedWave, lane } = parseLanesArgs(args);
				let wave = parsedWave;
				let scanDir: string | undefined;
				if (wave === undefined) {
					// The lone readable wave skips the wave ceremony: bare /lanes is its table.
					const scans = scanWaves(scanDirs(), ctx.sessionManager.getSessionId(), hostname(), Date.now());
					const lone = defaultWaveOf(scans);
					if (lone === undefined) {
						ctx.ui.notify(formatWaveList(scans), "info");
						return;
					}
					wave = lone.wave;
					scanDir = lone.workDir;
				}
				const dirs = scanDirs();
				const workDir = scanDir ?? tracked.get(wave) ?? dirs.find((d) => fs.existsSync(manifestPathFor(d, wave))) ?? dirs[0];
				const m = readManifest(workDir, wave); // unknown wave → its error + the usage hint below
				if (lane === undefined) {
					const now = Date.now();
					// the sweep makes the tombstone authoritative — a lingering group member of a
					// killed lane must not read as running
					const lanes = deriveLanes(m.lanes, now).map((status, i) => ({ status, eventsPath: m.lanes[i].eventsPath, errPath: m.lanes[i].errPath }));
					const header = formatWaveHeader(wave, m.createdAt, lanes.map((x) => x.status), now);
					ctx.ui.notify(`${header}\n${formatWaveStatusTui(wave, lanes, renderPath)}`, "info");
					return;
				}
				const record = m.lanes.find((l) => l.name === lane);
				if (record === undefined) {
					throw new Error(`unknown lane '${lane}' in wave '${wave}' — valid lanes: ${m.lanes.map((l) => l.name).join(", ")}`);
				}
				const events = parseEvents(record.eventsPath);
				const artifactPath = artifactPathFor(m, record);
				const artifact =
					fs.existsSync(artifactPath) ? { path: artifactPath, content: fs.readFileSync(artifactPath, "utf8") } : undefined;
				ctx.ui.notify(
					formatLaneInspector(
						{
							wave,
							status: deriveLane(record, Date.now(), events),
							trace: deriveTrace(events),
							eventsPath: record.eventsPath,
							errPath: record.errPath,
							artifact,
						},
						renderPath,
					),
					"info",
				);
			} catch (e: any) {
				ctx.ui.notify(`${e.message}\n${lanesUsageLine()}`, "error");
			}
		},
	});
}
