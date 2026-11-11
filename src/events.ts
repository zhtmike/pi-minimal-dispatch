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
	model?: string;
	thinkingLevel?: string;
	usage?: UsageDelta;
	content?: ContentBlock[];
};

export type LaneEvent = { type: string } & Record<string, unknown>;

/**
 * Parse a lane's JSONL event file. A trailing line lacking its newline is kept
 * only when it is already complete JSON (a writer caught between payload and
 * newline); a torn one is skipped. Any other unparseable line is corruption
 * and throws. Returns [] when the file does not exist yet.
 */
export function parseEvents(eventsPath: string): LaneEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	const raw = fs.readFileSync(eventsPath, "utf8");
	if (raw === "") return [];
	const events: LaneEvent[] = [];
	parseEventsTail(raw, events, 0, eventsPath);
	return events;
}

/**
 * Parse appended JSONL bytes onto `events` (line numbers continue at `lineNo`).
 * Complete lines parse strictly — a corrupt one throws naming its absolute
 * line; the final unterminated line is attempted and kept only when already
 * complete JSON. Returns the bytes consumed and the running line count — a
 * torn remainder stays unconsumed for the next read.
 */
export function parseEventsTail(raw: string, events: LaneEvent[], lineNo: number, eventsPath: string): { consumed: number; lineNo: number } {
	let consumed = 0;
	let n = lineNo;
	let start = 0;
	while (start < raw.length) {
		const nl = raw.indexOf("\n", start);
		const line = nl === -1 ? raw.slice(start) : raw.slice(start, nl);
		if (nl === -1) {
			if (line !== "") {
				try {
					events.push(JSON.parse(line) as LaneEvent);
					n++;
					consumed = raw.length;
				} catch {
					// torn write — leave the bytes unconsumed; the next read completes them
				}
			}
			break;
		}
		n++;
		if (line !== "") {
			try {
				events.push(JSON.parse(line) as LaneEvent);
			} catch (e: any) {
				throw new Error(`corrupt event line ${n} in ${eventsPath}: ${e.message}`);
			}
		}
		consumed = nl + 1;
		start = nl + 1;
	}
	// Line positions above are string units; the contract is bytes. `\n` never sits inside
	// a UTF-8 sequence, so the consumed prefix is whole characters and re-encodes exactly.
	return { consumed: Buffer.byteLength(raw.slice(0, consumed), "utf8"), lineNo: n };
}

/** Narrow an event to an assistant `message_end`, else null. */
export function assistantMessageEnd(e: LaneEvent): StreamMessage | null {
	if (e.type !== "message_end") return null;
	const message = (e as { message?: StreamMessage }).message;
	if (message === undefined || message.role !== "assistant") return null;
	return message;
}

/**
 * Narrow an event to an assistant `message_start`, else null. pi's message_start
 * carries the initial message with `model` already set (proxy.ts builds the partial
 * with the answering model's id) but no `thinkingLevel` — that lands at message_end.
 */
export function assistantMessageStart(e: LaneEvent): StreamMessage | null {
	if (e.type !== "message_start") return null;
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
