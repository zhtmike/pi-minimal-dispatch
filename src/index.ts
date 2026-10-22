/**
 * pi-minimal-dispatch — detached lane dispatch with visible state (README.md).
 * `dispatch`: spawn a wave of detached `timeout … pi --mode json …` lanes, return immediately.
 * `lanes`: stateless status/kill/collect over the wave's manifest + event streams.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_DEADLINE_SEC,
	KILL_GRACE_MS,
	type LaneRecord,
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

function resolveExecutable(name: string): string {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const p = path.join(dir, name);
		try {
			fs.accessSync(p, fs.constants.X_OK);
			return p;
		} catch {
			// keep scanning
		}
	}
	throw new Error(`executable '${name}' not found on PATH`);
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

function assertSlugs(wave: string, names: string[]): void {
	const bad: string[] = [];
	if (!SLUG.test(wave)) bad.push(`wave '${wave}'`);
	for (const n of names) if (!SLUG.test(n)) bad.push(`lane '${n}'`);
	const dupes = names.filter((n, i) => names.indexOf(n) !== i);
	for (const d of new Set(dupes)) bad.push(`duplicate lane '${d}'`);
	if (bad.length > 0) throw new Error(`slugs must be kebab-case [a-z0-9-], max 64 chars, unique: ${bad.join(", ")}`);
}

const dispatchTool = defineTool({
	name: "dispatch",
	label: "Dispatch lanes",
	description:
		"Spawn detached sub-agent lanes (fresh pi processes) for a wave and return immediately. " +
		"Each lane runs `timeout <deadlineSec> pi --mode json --no-session -ns [flags] @<briefPath>` in its own " +
		"process group, streaming JSON events to <workDir>/<wave>-<name>.events.jsonl. Lanes survive this " +
		"session's exit. Write briefs first (one file per lane, addressee = dispatched leaf). " +
		"Then poll with the lanes tool; collect artifacts when settled.",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug (kebab-case); must not already exist in workDir" }),
		lanes: Type.Array(
			Type.Object({
				name: Type.String({ description: "Lane slug (kebab-case, unique within the wave)" }),
				briefPath: Type.String({ description: "Path to the lane's brief file (@file prompt)" }),
				model: Type.Optional(Type.String({ description: "Pin a model id for this lane" })),
				deadlineSec: Type.Optional(Type.Number({ description: `Deadline leash in seconds (default ${DEFAULT_DEADLINE_SEC})`, minimum: 1 })),
				tools: Type.Optional(Type.String({ description: "Tool allowlist passed to --tools, e.g. 'read,grep,find,ls,bash'" })),
				noExtensions: Type.Optional(Type.Boolean({ description: "Pass -ne (drop extensions incl. MCP)" })),
				mcp: Type.Optional(Type.Boolean({ description: "Set false to pass --no-mcp (default: MCP reachable per exposure)" })),
			}),
			{ minItems: 1 },
		),
		workDir: Type.Optional(Type.String({ description: "Directory for briefs/events/manifest (default .pi/work)" })),
	}),

	async execute(_id, params) {
		const workDir = path.resolve(params.workDir ?? ".pi/work");
		fs.mkdirSync(workDir, { recursive: true });
		// Slugs are validated before the manifest claim: a post-claim throw would strand the slug.
		assertSlugs(params.wave, params.lanes.map((l) => l.name));

		// All briefs must exist before anything spawns: report every missing one.
		const missing: string[] = [];
		for (const lane of params.lanes) {
			const abs = path.resolve(lane.briefPath);
			if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) missing.push(lane.briefPath);
		}
		if (missing.length > 0) {
			throw new Error(`brief file(s) not found: ${missing.join(", ")} — nothing spawned`);
		}

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
			timeoutBin = resolveExecutable("timeout");
			resolveExecutable("pi");
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
			const briefPath = path.resolve(lane.briefPath);
			const eventsPath = path.join(workDir, `${params.wave}-${lane.name}.events.jsonl`);
			const errPath = path.join(workDir, `${params.wave}-${lane.name}.err`);
			const record: LaneRecord = {
				name: lane.name,
				briefPath,
				eventsPath,
				errPath,
				pid: null,
				processStart: null,
				startedAt: new Date().toISOString(),
				deadlineSec: lane.deadlineSec ?? DEFAULT_DEADLINE_SEC,
				model: lane.model,
				tools: lane.tools,
				spawned: false,
			};

			let outFd = -1;
			let errFd = -1;
			try {
				outFd = fs.openSync(eventsPath, "w");
				errFd = fs.openSync(errPath, "w");
				const args = [
					String(record.deadlineSec),
					"pi",
					"--mode",
					"json",
					"--no-session",
					"-ns",
					...(lane.noExtensions ? ["-ne"] : []),
					...(lane.tools ? ["--tools", lane.tools] : []),
					...(lane.mcp === false ? ["--no-mcp"] : []),
					...(lane.model ? ["--model", lane.model] : []),
					`@${briefPath}`,
				];
				const child = spawn(timeoutBin, args, {
					detached: true, // own process group; survives this process's exit
					stdio: ["ignore", outFd, errFd],
					env: process.env,
				});
				child.unref();
				child.on("error", (e) => {
					// Async spawn failure lands after we returned; the cause goes to .err
					try {
						fs.appendFileSync(errPath, `\n[pi-minimal-dispatch] spawn error: ${e.message}\n`);
					} catch {}
				});
				record.pid = child.pid;
				record.processStart = psLstart(child.pid!);
				record.spawned = true;
			} catch (e: any) {
				record.spawnError = e.message;
			} finally {
				if (outFd !== -1) fs.closeSync(outFd);
				if (errFd !== -1) fs.closeSync(errFd);
			}
			manifest.lanes.push(record);
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
		"(SIGKILL after grace), start-time guarded. action=collect: write each finished lane's final assistant " +
		"message to <wave>-<name>.md (suspect-flagged on non-clean stopReason). Stateless: reads the manifest " +
		"fresh — works across sessions, including after the dispatcher exited.",
	parameters: Type.Object({
		wave: Type.String({ description: "Wave slug" }),
		action: Type.Optional(StringEnum(["status", "kill", "collect"])),
		workDir: Type.Optional(Type.String({ description: "Directory holding the manifest (default .pi/work)" })),
	}),

	async execute(_id, params, signal) {
		const workDir = path.resolve(params.workDir ?? ".pi/work");
		const action = params.action ?? "status";
		const manifest = readManifest(workDir, params.wave);

		if (action === "status") {
			const now = Date.now();
			const statuses = manifest.lanes.map((l) => deriveLane(l, now));
			const text = statuses
				.map((s) => {
					const bits = [s.name, s.state];
					if (s.cause) bits.push(`(${s.cause}${s.spawnError ? `: ${s.spawnError}` : ""})`);
					if (s.overdue) bits.push("OVERDUE");
					bits.push(`${s.turns} turns`);
					bits.push(`tok ${s.usage.input}in/${s.usage.output}out, $${s.usage.cost.toFixed(4)}`);
					if (s.stopReason !== undefined) bits.push(`stop:${s.stopReason}`);
					if (s.lastEventAgeSec !== null) bits.push(`last ${s.lastEventAgeSec}s ago`);
					return `  ${bits.join(" · ")}` + (s.errTail ? `\n    err: ${s.errTail.replace(/\n/g, "\n    ")}` : "");
				})
				.join("\n");
			return {
				content: [{ type: "text", text: `wave '${params.wave}':\n${text}` }],
				structuredContent: { wave: params.wave, lanes: statuses },
				details: { wave: params.wave },
			};
		}

		if (action === "kill") {
			const killed: string[] = [];
			try {
				for (const lane of manifest.lanes) {
					if (lane.pid === null || !lane.spawned) continue;
					if (!pidAlive(lane.pid, lane.processStart)) continue; // never signal a reused PID
					if (deriveLane(lane, Date.now()).state === "settled") continue;
					try {
						process.kill(-lane.pid, "SIGTERM"); // negative = process group (timeout + pi)
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
				const deadline = Date.now() + KILL_GRACE_MS;
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

export default function (pi: ExtensionAPI) {
	pi.registerTool(dispatchTool);
	pi.registerTool(lanesTool);
}
