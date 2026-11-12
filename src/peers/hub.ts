/**
 * The hub is the shared state of a grove: a directory that every peer reads and writes.
 *
 * It lives in `<git common dir>/pi-grove/`. The git common directory is shared by all worktrees
 * of a repository, so every pi process started in any worktree finds the same hub. There is no
 * coordinator process: peers are equal and each one only writes its own record, appends
 * messages to other peers' inboxes, and appends to the shared board.
 *
 *   peers/<id>.json        one record per peer, rewritten by its owner
 *   inbox/<id>/<msg>.json  messages waiting for a peer; the owner deletes them when read
 *   messages.jsonl         append-only log of every message
 *   board.jsonl            append-only shared notes
 *   config.json            settings for this repository; they override the user's defaults
 *   logs/<id>.log          output of background peers
 *
 * This module is pure file I/O with no dependency on pi.
 */

import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type PeerMode = "auto" | "manual" | "off";

export const PEER_MODES: readonly PeerMode[] = ["auto", "manual", "off"];

export interface HubConfig {
	/** How eagerly agents use peers. See the README. */
	mode: PeerMode;
	/** Upper limit of live peers, including the ones started by the user. */
	maxPeers: number;
}

export const DEFAULT_CONFIG: HubConfig = { mode: "auto", maxPeers: 4 };

export type PeerStatus = "idle" | "working" | "exited";

export interface PeerRecord {
	id: string;
	pid: number;
	cwd: string;
	branch?: string;
	sessionId?: string;
	sessionFile?: string;
	status: PeerStatus;
	/** True for a peer started by another peer as a background process. */
	background: boolean;
	/** Peer that started this one, if any. Recorded for display; it grants no authority. */
	spawnedBy?: string;
	/** Entry of the spawning session where this peer's session branched off. */
	forkedFrom?: string;
	/** What the peer was asked to do, or what it last reported it is doing. */
	task?: string;
	startedAt: number;
	lastSeen: number;
}

export interface PeerView extends PeerRecord {
	/** True when the peer's process still exists. */
	alive: boolean;
}

export interface PeerMessage {
	id: string;
	time: number;
	from: string;
	to: string;
	text: string;
	/** Leaf entry of the sender's session when the message was sent. Draws the graph edge. */
	fromEntryId?: string;
	fromSessionId?: string;
}

export interface BoardNote {
	time: number;
	from: string;
	text: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Peer names are used in file names and branch names. */
export function isValidPeerName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

export function toPeerName(text: string): string {
	const name = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 31)
		.replace(/-+$/, "");
	return name || "peer";
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function readJsonLines<T>(file: string): T[] {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const values: T[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line) as T);
		} catch {
			// A line being appended by another process; it is complete on the next read.
		}
	}
	return values;
}

let sequence = 0;

function uniqueId(): string {
	sequence = (sequence + 1) % 1_000_000;
	return `${Date.now().toString(36)}-${process.pid.toString(36)}-${sequence.toString(36).padStart(4, "0")}`;
}

/** Reads a config file and keeps only the valid settings in it. */
export function readConfigFile(file: string): Partial<HubConfig> {
	const stored = readJson<Record<string, unknown>>(file) ?? {};
	const config: Partial<HubConfig> = {};
	if (PEER_MODES.includes(stored.mode as PeerMode)) config.mode = stored.mode as PeerMode;
	if (typeof stored.maxPeers === "number" && stored.maxPeers >= 1) config.maxPeers = Math.floor(stored.maxPeers);
	return config;
}

/** Merges `patch` into a config file, creating the file and its directory when needed. */
export function writeConfigFile(file: string, patch: Partial<HubConfig>): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify({ ...readConfigFile(file), ...patch }, null, 2)}\n`);
	renameSync(temporary, file);
}

export class Hub {
	readonly root: string;
	private readonly defaultsFile: string | undefined;

	/** `defaultsFile` is the user's config file with defaults for every repository. */
	constructor(root: string, defaultsFile?: string) {
		this.root = root;
		this.defaultsFile = defaultsFile;
	}

	private path(...parts: string[]): string {
		return join(this.root, ...parts);
	}

	/** Writes through a temporary file so readers never see half a record. */
	private writeJson(file: string, value: unknown): void {
		const temporary = `${file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
		renameSync(temporary, file);
	}

	/** Built-in defaults, then the user's defaults, then this repository's settings. */
	getConfig(): HubConfig {
		const user = this.defaultsFile ? readConfigFile(this.defaultsFile) : {};
		return { ...DEFAULT_CONFIG, ...user, ...readConfigFile(this.path("config.json")) };
	}

	/** True when this repository has its own value for `key`. */
	overrides(key: keyof HubConfig): boolean {
		return readConfigFile(this.path("config.json"))[key] !== undefined;
	}

	/** Changes settings for this repository only. */
	setConfig(patch: Partial<HubConfig>): HubConfig {
		writeConfigFile(this.path("config.json"), patch);
		return this.getConfig();
	}

	logFile(id: string): string {
		mkdirSync(this.path("logs"), { recursive: true });
		return this.path("logs", `${id}.log`);
	}

	/** All known peers, live ones first. */
	list(): PeerView[] {
		let names: string[];
		try {
			names = readdirSync(this.path("peers"));
		} catch {
			return [];
		}
		const peers: PeerView[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const record = readJson<PeerRecord>(this.path("peers", name));
			if (!record || typeof record.id !== "string") continue;
			const alive = record.status !== "exited" && isAlive(record.pid);
			peers.push({ ...record, status: alive ? record.status : "exited", alive });
		}
		return peers.sort((a, b) => Number(b.alive) - Number(a.alive) || a.startedAt - b.startedAt);
	}

	get(id: string): PeerView | undefined {
		return this.list().find((peer) => peer.id === id);
	}

	/** A name based on `wanted` that no live peer other than this process uses. */
	freeName(wanted: string): string {
		const base = toPeerName(wanted);
		const taken = new Set(
			this.list()
				.filter((peer) => peer.alive && peer.pid !== process.pid)
				.map((peer) => peer.id),
		);
		if (!taken.has(base)) return base;
		for (let n = 2; ; n++) {
			const candidate = `${base.slice(0, 28)}-${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	/** Creates or replaces a peer record. */
	register(record: PeerRecord): void {
		mkdirSync(this.path("peers"), { recursive: true });
		mkdirSync(this.path("inbox", record.id), { recursive: true });
		this.writeJson(this.path("peers", `${record.id}.json`), record);
	}

	/** Updates fields of an existing record. Does nothing if the record is gone. */
	update(id: string, patch: Partial<PeerRecord>): void {
		const file = this.path("peers", `${id}.json`);
		const record = readJson<PeerRecord>(file);
		if (!record) return;
		this.writeJson(file, { ...record, ...patch, id, lastSeen: Date.now() });
	}

	/** Deletes the record of a peer that is not running. */
	forget(id: string): boolean {
		const peer = this.get(id);
		if (!peer || peer.alive) return false;
		rmSync(this.path("peers", `${id}.json`), { force: true });
		rmSync(this.path("inbox", id), { recursive: true, force: true });
		return true;
	}

	/** Delivers a message to one peer's inbox and appends it to the log. */
	send(message: Omit<PeerMessage, "id" | "time"> & { time?: number }): PeerMessage {
		const full: PeerMessage = { ...message, id: uniqueId(), time: message.time ?? Date.now() };
		const inbox = this.path("inbox", full.to);
		mkdirSync(inbox, { recursive: true });
		this.writeJson(join(inbox, `${full.id}.json`), full);
		appendFileSync(this.path("messages.jsonl"), `${JSON.stringify(full)}\n`);
		return full;
	}

	/** True when messages are waiting in a peer's inbox. */
	hasPending(id: string): boolean {
		try {
			return readdirSync(this.path("inbox", id)).some((name) => name.endsWith(".json"));
		} catch {
			return false;
		}
	}

	/** Removes and returns the messages waiting for a peer, oldest first. */
	drain(id: string): PeerMessage[] {
		const inbox = this.path("inbox", id);
		let names: string[];
		try {
			names = readdirSync(inbox);
		} catch {
			return [];
		}
		const messages: PeerMessage[] = [];
		for (const name of names.sort()) {
			if (!name.endsWith(".json")) continue;
			const file = join(inbox, name);
			const message = readJson<PeerMessage>(file);
			rmSync(file, { force: true });
			if (message && typeof message.text === "string") messages.push(message);
		}
		return messages.sort((a, b) => a.time - b.time);
	}

	/** The most recent messages, oldest first. */
	messages(limit = 50): PeerMessage[] {
		return readJsonLines<PeerMessage>(this.path("messages.jsonl")).slice(-limit);
	}

	postNote(from: string, text: string, time = Date.now()): BoardNote {
		const note: BoardNote = { time, from, text };
		mkdirSync(this.root, { recursive: true });
		appendFileSync(this.path("board.jsonl"), `${JSON.stringify(note)}\n`);
		return note;
	}

	/** The most recent board notes, oldest first. */
	notes(limit = 30): BoardNote[] {
		return readJsonLines<BoardNote>(this.path("board.jsonl")).slice(-limit);
	}
}
