/**
 * Starting a peer: fork the session tree at one entry into a new session file, then run pi on
 * that session in the peer's worktree as a background process.
 *
 * A background peer is a normal pi process in RPC mode. It loads this extension itself, joins
 * the hub like any other peer, and receives its task through its inbox. The process that
 * started it only keeps its input open, answers dialogs it cannot show, and writes its log.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RawEntry } from "../graph/model.ts";

export interface ForkOptions {
	/** Every entry of the source session. */
	entries: RawEntry[];
	/** Entry to fork at, or null for a session without history. */
	fromId: string | null;
	/** Working directory of the new session. */
	cwd: string;
	/** Directory where pi keeps sessions for `cwd`. */
	sessionDir: string;
	/** Session file the fork comes from. */
	parentSession?: string;
	/** Session format version of the source session. */
	version?: number;
	now?: Date;
}

export interface ForkedSession {
	file: string;
	sessionId: string;
}

/** The entries from the root down to `fromId`, in file order. */
export function pathTo(entries: RawEntry[], fromId: string | null): RawEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: RawEntry[] = [];
	const seen = new Set<string>();
	let cursor = fromId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry) break;
		path.push(entry);
		cursor = entry.parentId;
	}
	return path.reverse();
}

function isMidTurn(entry: RawEntry): boolean {
	if (entry.type !== "message") return false;
	const message = entry.message as { role?: unknown; content?: unknown } | undefined;
	if (message?.role === "toolResult") return true;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some((block) => (block as { type?: unknown } | null)?.type === "toolCall");
}

/**
 * The nearest entry at or above `id` where a session can be cut. A session that ends between a
 * tool call and its results is rejected by model providers, so the cut moves up past assistant
 * messages that call tools and past tool results. In practice that is the prompt of the turn.
 */
export function safeForkPoint(entries: RawEntry[], id: string | null): string | null {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const seen = new Set<string>();
	let cursor = id;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry) return null;
		if (!isMidTurn(entry)) return entry.id;
		cursor = entry.parentId;
	}
	return null;
}

/**
 * Writes a new session file holding the path from the root to `fromId`. Entry ids are kept, so
 * the new session is a branch of the same tree and the graph can draw both together.
 */
export function forkSession(options: ForkOptions): ForkedSession {
	const now = options.now ?? new Date();
	const sessionId = randomUUID();
	const header = {
		type: "session",
		version: options.version ?? 3,
		id: sessionId,
		timestamp: now.toISOString(),
		cwd: options.cwd,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	const lines = [header, ...pathTo(options.entries, options.fromId)].map((value) => JSON.stringify(value));
	mkdirSync(options.sessionDir, { recursive: true });
	const file = join(options.sessionDir, `${now.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return { file, sessionId };
}

export const ENV_PEER_NAME = "PI_GROVE_PEER";
export const ENV_SPAWNED_BY = "PI_GROVE_SPAWNED_BY";
export const ENV_FORKED_FROM = "PI_GROVE_FORKED_FROM";
export const ENV_PI_BIN = "PI_GROVE_PI_BIN";

export interface SpawnOptions {
	name: string;
	cwd: string;
	sessionFile: string;
	logFile: string;
	spawnedBy: string;
	forkedFrom?: string;
	/** Model pattern passed to `--model`, if any. */
	model?: string;
}

export interface BackgroundPeer {
	name: string;
	pid: number;
	child: ChildProcess;
}

// Kept on globalThis so that running peers survive `/reload` and session switches, which
// create a new instance of this extension inside the same process.
const REGISTRY = Symbol.for("pi-grove.background-peers");

function registry(): Map<string, BackgroundPeer> {
	const holder = globalThis as { [REGISTRY]?: Map<string, BackgroundPeer> };
	holder[REGISTRY] ??= new Map();
	return holder[REGISTRY];
}

export function backgroundPeers(): BackgroundPeer[] {
	return [...registry().values()];
}

/**
 * Answers a dialog request from a background peer. Nobody is there to answer, so every dialog
 * is cancelled; an extension that asks for permission then takes its safe default.
 */
export function dialogReply(line: string): string | undefined {
	let record: { type?: unknown; id?: unknown; method?: unknown };
	try {
		record = JSON.parse(line) as typeof record;
	} catch {
		return undefined;
	}
	if (record.type !== "extension_ui_request" || typeof record.id !== "string") return undefined;
	if (!["select", "confirm", "input", "editor"].includes(String(record.method))) return undefined;
	return JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true });
}

/** Root directory of this package: the directory that holds `src/`. */
export function packageRoot(): string {
	return dirname(dirname(dirname(fileURLToPath(import.meta.url))));
}

export function spawnBackgroundPeer(options: SpawnOptions): BackgroundPeer {
	// A peer must load this extension to join the grove. Passing it explicitly also covers a
	// session that was itself started with `pi -e`; when the package is installed as well, the
	// second copy sees the first one and stays inactive.
	const args = ["--mode", "rpc", "-e", packageRoot(), "--session", options.sessionFile, "--name", `grove:${options.name}`];
	if (options.model) args.push("--model", options.model);
	const child = spawn(process.env[ENV_PI_BIN] || "pi", args, {
		cwd: options.cwd,
		env: {
			...process.env,
			[ENV_PEER_NAME]: options.name,
			[ENV_SPAWNED_BY]: options.spawnedBy,
			[ENV_FORKED_FROM]: options.forkedFrom ?? "",
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (child.pid === undefined) throw new Error("could not start pi for the peer");

	const log = createWriteStream(options.logFile, { flags: "a" });
	let buffered = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		log.write(chunk);
		buffered += chunk.toString("utf8");
		let end = buffered.indexOf("\n");
		while (end !== -1) {
			const reply = dialogReply(buffered.slice(0, end));
			if (reply && child.stdin?.writable) child.stdin.write(`${reply}\n`);
			buffered = buffered.slice(end + 1);
			end = buffered.indexOf("\n");
		}
	});
	child.stderr?.on("data", (chunk: Buffer) => log.write(chunk));
	child.stdin?.on("error", () => {});
	child.on("error", (error) => log.write(`\n[pi-grove] ${error.message}\n`));
	child.on("exit", (code, signal) => {
		log.end(`\n[pi-grove] peer exited (code ${code ?? "none"}, signal ${signal ?? "none"})\n`);
		if (registry().get(options.name)?.child === child) registry().delete(options.name);
	});

	const peer: BackgroundPeer = { name: options.name, pid: child.pid, child };
	registry().set(options.name, peer);
	return peer;
}

/** Asks a background peer started by this process to shut down. */
export function stopBackgroundPeer(name: string): boolean {
	const peer = registry().get(name);
	if (!peer) return false;
	// Closing stdin asks pi for an orderly shutdown; the signal covers a peer that is mid-run.
	peer.child.stdin?.end();
	peer.child.kill("SIGTERM");
	return true;
}

export function stopAllBackgroundPeers(): void {
	for (const peer of backgroundPeers()) stopBackgroundPeer(peer.name);
}
