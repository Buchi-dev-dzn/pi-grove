/**
 * Reflog: a per-session journal of where the leaf ("HEAD") of the session tree has been.
 *
 * pi records entries, but not the moves between branches unless a branch summary is written.
 * The journal keeps every move so that a `/tree` jump can be undone, like `git reflog`.
 * It lives outside the session file, in `<agent dir>/pi-grove/reflog/<session id>.jsonl`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ReflogKind =
	/** The session was opened. */
	| "start"
	/** The conversation advanced by itself to `to` before a move away from it. */
	| "advance"
	/** A jump within the tree (`/tree`, or a jump from the grove view). */
	| "move"
	/** A jump that left a branch summary behind. */
	| "summarize";

export interface ReflogEntry {
	time: number;
	kind: ReflogKind;
	from: string | null;
	to: string | null;
	note?: string;
}

export class Reflog {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	private file(sessionId: string): string {
		return join(this.directory, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.jsonl`);
	}

	/** Oldest first. */
	read(sessionId: string): ReflogEntry[] {
		let content: string;
		try {
			content = readFileSync(this.file(sessionId), "utf8");
		} catch {
			return [];
		}
		const entries: ReflogEntry[] = [];
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const value = JSON.parse(line) as ReflogEntry;
				if (typeof value.time === "number" && typeof value.kind === "string") entries.push(value);
			} catch {
				// Skip a damaged line; the rest of the journal is still useful.
			}
		}
		return entries;
	}

	private append(sessionId: string, entry: ReflogEntry): void {
		mkdirSync(this.directory, { recursive: true });
		appendFileSync(this.file(sessionId), `${JSON.stringify(entry)}\n`);
	}

	/** Records the position at session start, unless the journal already ends there. */
	recordStart(sessionId: string, leafId: string | null, note?: string, time = Date.now()): void {
		const last = this.read(sessionId).at(-1);
		if (last && last.to === leafId) return;
		this.append(sessionId, { time, kind: "start", from: last?.to ?? null, to: leafId, note });
	}

	/**
	 * Records a jump from `from` to `to`. If the journal does not end at `from`, the conversation
	 * advanced there on its own; that position is recorded first so the jump can be undone.
	 */
	recordMove(sessionId: string, from: string | null, to: string | null, summarized: boolean, time = Date.now()): void {
		if (from === to) return;
		const last = this.read(sessionId).at(-1);
		if (from && last?.to !== from) {
			this.append(sessionId, { time: time - 1, kind: "advance", from: last?.to ?? null, to: from });
		}
		this.append(sessionId, { time, kind: summarized ? "summarize" : "move", from, to });
	}
}
