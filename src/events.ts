/**
 * pi-minimal-dispatch lane event stream — typed parsing of a lane's
 * `pi --mode json` JSONL output (see pi's JSON Event Stream docs).
 */

import * as fs from "node:fs";

export type UsageDelta = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

export type ContentBlock = { type: string; text?: string; thinking?: string };

export type StreamMessage = {
	role: string;
	stopReason?: string;
	usage?: UsageDelta;
	content?: ContentBlock[];
};

export type LaneEvent = { type: string } & Record<string, unknown>;

/**
 * Parse a lane's JSONL event file. A trailing line lacking its newline is a
 * SIGTERM-truncated write and is skipped; any other unparseable line is
 * corruption and throws. Returns [] when the file does not exist yet.
 */
export function parseEvents(eventsPath: string): LaneEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	const raw = fs.readFileSync(eventsPath, "utf8");
	if (raw === "") return [];
	const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n").slice(0, -1);
	const events: LaneEvent[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i] === "") continue;
		try {
			events.push(JSON.parse(lines[i]) as LaneEvent);
		} catch (e: any) {
			throw new Error(`corrupt event line ${i + 1} in ${eventsPath}: ${e.message}`);
		}
	}
	return events;
}

/** Narrow an event to an assistant `message_end`, else null. */
export function assistantMessageEnd(e: LaneEvent): StreamMessage | null {
	if (e.type !== "message_end") return null;
	const message = (e as { message?: StreamMessage }).message;
	if (message === undefined || message.role !== "assistant") return null;
	return message;
}

/** Concatenated text blocks of an assistant message; empty when it has none. */
export function messageText(message: StreamMessage): string {
	const blocks = Array.isArray(message.content) ? message.content : [];
	return blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}
