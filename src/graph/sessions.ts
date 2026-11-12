/**
 * Reads pi session files (JSONL) and finds the sessions related to the current one.
 *
 * Related sessions are the ones the current session was forked from, the ones forked from it,
 * and the sessions of grove peers. Files are parsed directly so that sessions owned by other
 * running pi processes can be read without opening them through pi.
 */

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { GroveSource, RawEntry } from "./model.ts";

export interface SessionHeaderInfo {
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

export interface ParsedSession {
	header: SessionHeaderInfo;
	entries: RawEntry[];
	/** The last entry in the file. pi appends at the leaf, so this is where the session stands. */
	lastEntryId: string | null;
	name?: string;
}

function parseLine(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		// A session file being written by another process can end in a partial line.
		return undefined;
	}
}

function toHeader(value: Record<string, unknown> | undefined): SessionHeaderInfo | undefined {
	if (!value || value.type !== "session" || typeof value.id !== "string") return undefined;
	return {
		id: value.id,
		timestamp: typeof value.timestamp === "string" ? value.timestamp : "",
		cwd: typeof value.cwd === "string" ? value.cwd : "",
		parentSession: typeof value.parentSession === "string" ? value.parentSession : undefined,
	};
}

export function parseSession(content: string): ParsedSession | undefined {
	const lines = content.split("\n");
	const header = toHeader(parseLine(lines[0] ?? ""));
	if (!header) return undefined;
	const entries: RawEntry[] = [];
	let name: string | undefined;
	for (let i = 1; i < lines.length; i++) {
		const value = parseLine(lines[i] ?? "");
		if (!value || typeof value.id !== "string" || typeof value.type !== "string") continue;
		const entry = value as RawEntry;
		if (entry.parentId === undefined) entry.parentId = null;
		if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name ? entry.name : undefined;
		entries.push(entry);
	}
	return { header, entries, lastEntryId: entries[entries.length - 1]?.id ?? null, name };
}

/** Reads only the first line of a session file. */
export function readHeader(file: string): SessionHeaderInfo | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buffer = Buffer.alloc(4096);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, length);
		const end = text.indexOf("\n");
		return toHeader(parseLine(end === -1 ? text : text.slice(0, end)));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

const cache = new Map<string, { stamp: string; session: ParsedSession }>();

export function readSession(file: string): ParsedSession | undefined {
	try {
		const stat = statSync(file);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		const cached = cache.get(file);
		if (cached?.stamp === stamp) return cached.session;
		const session = parseSession(readFileSync(file, "utf8"));
		if (session) cache.set(file, { stamp, session });
		return session;
	} catch {
		return undefined;
	}
}

/**
 * Session files connected to `currentFile` through `parentSession` links: its ancestors, and the
 * sessions in `directories` that descend from it or from one of its ancestors.
 */
export function findRelatedSessions(currentFile: string, directories: string[], limit = 24): string[] {
	const current = resolve(currentFile);
	const family = new Set<string>([current]);

	let cursor: string | undefined = current;
	for (let depth = 0; cursor && depth < 16; depth++) {
		const parent: string | undefined = readHeader(cursor)?.parentSession;
		if (!parent) break;
		cursor = resolve(parent);
		if (family.has(cursor)) break;
		family.add(cursor);
	}

	const parentOf = new Map<string, string>();
	for (const directory of new Set([dirname(current), ...directories])) {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const file = resolve(join(directory, name));
			if (family.has(file)) continue;
			const parent = readHeader(file)?.parentSession;
			if (parent) parentOf.set(file, resolve(parent));
		}
	}
	// Repeat until no new descendant joins: a fork of a fork is found on a later pass.
	for (let changed = true; changed; ) {
		changed = false;
		for (const [file, parent] of parentOf) {
			if (!family.has(file) && family.has(parent)) {
				family.add(file);
				changed = true;
			}
		}
	}

	family.delete(current);
	return [...family].slice(0, limit);
}

export interface CurrentSession {
	sessionId: string;
	sessionFile?: string;
	created: number;
	name?: string;
	entries: RawEntry[];
	leafId: string | null;
}

export interface OtherSession {
	file: string;
	/** Overrides the name stored in the session, for example with a peer name. */
	name?: string;
}

/** Builds graph sources from the live current session and from other session files. */
export function loadSources(current: CurrentSession, others: OtherSession[]): GroveSource[] {
	const sources: GroveSource[] = [
		{
			sessionId: current.sessionId,
			sessionFile: current.sessionFile,
			name: current.name,
			created: current.created,
			entries: current.entries,
			leafId: current.leafId,
			isCurrent: true,
		},
	];
	const seen = new Set<string>([current.sessionId]);
	for (const other of others) {
		if (current.sessionFile && resolve(other.file) === resolve(current.sessionFile)) continue;
		const session = readSession(other.file);
		if (!session || seen.has(session.header.id)) continue;
		seen.add(session.header.id);
		const created = Date.parse(session.header.timestamp);
		sources.push({
			sessionId: session.header.id,
			sessionFile: other.file,
			name: other.name ?? session.name,
			created: Number.isNaN(created) ? 0 : created,
			entries: session.entries,
			leafId: session.lastEntryId,
			isCurrent: false,
		});
	}
	return sources;
}
