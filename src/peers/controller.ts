/**
 * Connects one pi session to the grove: joins the hub as a peer, delivers incoming messages
 * into the conversation, and starts new peers.
 *
 * Every pi process that loads this extension inside a git repository is a peer, whether the
 * user started it in a terminal or another peer started it in the background. They all run
 * this same code and have the same tools.
 */

import { basename, dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { PEER_MESSAGE_TYPE, peerMessageContent, type RawEntry } from "../graph/model.ts";
import { Hub, type HubConfig, isValidPeerName, type PeerMessage, type PeerMode, type PeerView, toPeerName, writeConfigFile } from "./hub.ts";
import {
	ENV_FORKED_FROM,
	ENV_PEER_NAME,
	ENV_SPAWNED_BY,
	forkSession,
	safeForkPoint,
	spawnBackgroundPeer,
	stopAllBackgroundPeers,
	stopBackgroundPeer,
} from "./runtime.ts";
import { commitsAhead, createWorktree, type Exec, findRepo, type RepoInfo, removeWorktree } from "./worktree.ts";

export const TOOL_NAMES = ["grove_peers", "grove_spawn", "grove_send", "grove_board"] as const;

const POLL_INTERVAL = 1500;
const JOIN_TIMEOUT = 20_000;
const HEARTBEAT_INTERVAL = 10_000;

/** The user's defaults for every repository: `<agent dir>/pi-grove/config.json`. */
export function userConfigFile(): string {
	return join(getAgentDir(), "pi-grove", "config.json");
}

export interface SpawnRequest {
	name: string;
	task: string;
	/** Entry to branch the peer's session from. Defaults to the current position. */
	fromId?: string | null;
	/** `fork` gives the peer the conversation so far; `fresh` starts it with only the task. */
	context?: "fork" | "fresh";
	model?: string;
}

export interface SpawnResult {
	name: string;
	branch: string;
	worktree: string;
	sessionFile: string;
	pid: number;
	/** True when the starting checkout had uncommitted changes that the peer does not see. */
	dirtySource: boolean;
	/** False when the peer process started but had not picked up its task after a short wait. */
	joined: boolean;
	logFile: string;
}

export interface MessageDetails {
	from: string;
	fromEntryId?: string;
	fromSessionId?: string;
	messageId: string;
}

export class PeerController {
	private readonly pi: ExtensionAPI;
	private readonly exec: Exec;
	private hub: Hub | undefined;
	private repo: RepoInfo | undefined;
	private id: string | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastHeartbeat = 0;
	private modeOverride: PeerMode | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.exec = (command, args, options) => pi.exec(command, args, options);
	}

	/** The hub, when the session runs inside a git repository. */
	get grove(): Hub | undefined {
		return this.hub;
	}

	get self(): string | undefined {
		return this.id;
	}

	get repository(): RepoInfo | undefined {
		return this.repo;
	}

	config(): HubConfig {
		const config = this.hub?.getConfig() ?? { mode: "off" as PeerMode, maxPeers: 0 };
		return this.modeOverride ? { ...config, mode: this.modeOverride } : config;
	}

	/** Peers are in use: there is a hub, the mode is not `off`, and this session has joined. */
	get active(): boolean {
		return this.hub !== undefined && this.id !== undefined && this.config().mode !== "off";
	}

	// ── lifecycle ────────────────────────────────────────────────────────────

	async start(ctx: ExtensionContext, modeFlag: string | undefined): Promise<void> {
		this.stopTimer();
		this.modeOverride = modeFlag === "auto" || modeFlag === "manual" || modeFlag === "off" ? modeFlag : undefined;
		this.repo = await findRepo(this.exec, ctx.cwd);
		this.hub = this.repo ? new Hub(join(this.repo.commonDir, "pi-grove"), userConfigFile()) : undefined;
		this.id = undefined;
		if (this.hub && this.repo && this.config().mode !== "off") this.join(ctx);
		this.syncTools();
	}

	private defaultName(repo: RepoInfo): string {
		return repo.root === repo.mainRoot ? "main" : toPeerName(basename(repo.root));
	}

	private join(ctx: ExtensionContext): void {
		const hub = this.hub;
		const repo = this.repo;
		if (!hub || !repo) return;
		// A background peer takes the name its starter reserved for it. The record written by the
		// starter holds the pid of the launcher, so it is replaced with this process's own pid.
		const reserved = process.env[ENV_PEER_NAME];
		const background = Boolean(reserved && isValidPeerName(reserved));
		const id = background && reserved ? reserved : hub.freeName(this.defaultName(repo));
		const previous = hub.get(id);
		const sameProcess = background || previous?.pid === process.pid;
		const now = Date.now();
		hub.register({
			id,
			pid: process.pid,
			cwd: ctx.cwd,
			branch: repo.branch,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile(),
			status: ctx.isIdle() ? "idle" : "working",
			background,
			spawnedBy: process.env[ENV_SPAWNED_BY] || undefined,
			forkedFrom: process.env[ENV_FORKED_FROM] || undefined,
			task: sameProcess ? previous?.task : undefined,
			startedAt: sameProcess ? (previous?.startedAt ?? now) : now,
			lastSeen: now,
		});
		this.id = id;
		this.lastHeartbeat = now;
		this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
		this.timer.unref?.();
		this.poll();
	}

	private stopTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Called when this extension instance goes away. `quit` means the process is exiting. */
	stop(quit: boolean): void {
		this.stopTimer();
		if (quit) {
			if (this.hub && this.id) this.hub.update(this.id, { status: "exited" });
			stopAllBackgroundPeers();
		}
	}

	setStatus(status: "idle" | "working"): void {
		if (this.hub && this.id) this.hub.update(this.id, { status });
	}

	/** Sets the mode for this repository and applies it to this session. */
	async setMode(ctx: ExtensionContext, mode: PeerMode): Promise<void> {
		if (!this.hub) throw new Error("peers need a git repository");
		this.modeOverride = undefined;
		this.hub.setConfig({ mode });
		this.applyMode(ctx);
	}

	/**
	 * Sets the user's default mode for every repository. Returns false when this repository has
	 * its own mode, which stays in effect here.
	 */
	setDefaultMode(ctx: ExtensionContext, mode: PeerMode): boolean {
		writeConfigFile(userConfigFile(), { mode });
		if (!this.hub || this.hub.overrides("mode")) return false;
		this.applyMode(ctx);
		return true;
	}

	/** Joins or leaves the grove so that this session matches the mode in effect. */
	private applyMode(ctx: ExtensionContext): void {
		if (!this.hub) return;
		if (this.config().mode === "off") {
			this.stopTimer();
			if (this.id) this.hub.update(this.id, { status: "exited" });
			this.id = undefined;
		} else if (!this.id) this.join(ctx);
		this.syncTools();
	}

	/** Shows the peer tools to the model only while peers are in use. */
	private syncTools(): void {
		const names = new Set<string>(TOOL_NAMES);
		const active = this.pi.getActiveTools();
		const others = active.filter((name) => !names.has(name));
		const wanted = this.active ? [...others, ...TOOL_NAMES] : others;
		if (wanted.length !== active.length || wanted.some((name) => !active.includes(name))) this.pi.setActiveTools(wanted);
	}

	// ── messages ─────────────────────────────────────────────────────────────

	private poll(): void {
		const hub = this.hub;
		const id = this.id;
		if (!hub || !id) return;
		try {
			const now = Date.now();
			if (now - this.lastHeartbeat >= HEARTBEAT_INTERVAL) {
				this.lastHeartbeat = now;
				hub.update(id, {});
			}
			for (const message of hub.drain(id)) this.deliver(message);
		} catch {
			// The extension instance was replaced (session switch or reload) or the hub is
			// unreachable. Stop polling; a new instance starts its own timer.
			this.stopTimer();
		}
	}

	private deliver(message: PeerMessage): void {
		const details: MessageDetails = {
			from: message.from,
			fromEntryId: message.fromEntryId,
			fromSessionId: message.fromSessionId,
			messageId: message.id,
		};
		this.pi.sendMessage(
			{ customType: PEER_MESSAGE_TYPE, content: peerMessageContent(message.from, message.text), display: true, details },
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	peers(): PeerView[] {
		return this.hub?.list() ?? [];
	}

	/** Sends a message to one peer, or to every other live peer when `to` is `all`. */
	send(ctx: ExtensionContext, to: string, text: string): string[] {
		const hub = this.hub;
		const id = this.id;
		if (!hub || !id) throw new Error("peers are off");
		const live = hub.list().filter((peer) => peer.alive && peer.id !== id);
		const targets = to === "all" ? live : live.filter((peer) => peer.id === to);
		if (targets.length === 0) {
			const names = live.map((peer) => peer.id).join(", ") || "none";
			throw new Error(to === "all" ? "there are no other live peers" : `no live peer named "${to}" (live peers: ${names})`);
		}
		for (const target of targets) {
			hub.send({
				from: id,
				to: target.id,
				text,
				fromEntryId: ctx.sessionManager.getLeafId() ?? undefined,
				fromSessionId: ctx.sessionManager.getSessionId(),
			});
		}
		return targets.map((target) => target.id);
	}

	// ── spawning ─────────────────────────────────────────────────────────────

	async spawn(ctx: ExtensionContext, request: SpawnRequest): Promise<SpawnResult> {
		const hub = this.hub;
		const repo = this.repo;
		const id = this.id;
		if (!hub || !repo || !id) throw new Error("peers are off or this is not a git repository");
		const name = toPeerName(request.name);
		const task = request.task.trim();
		if (!task) throw new Error("a peer needs a task");

		const config = this.config();
		const peers = hub.list();
		const live = peers.filter((peer) => peer.alive);
		if (live.length >= config.maxPeers) {
			throw new Error(`the grove already has ${live.length} live peers (limit ${config.maxPeers})`);
		}
		if (live.some((peer) => peer.id === name)) throw new Error(`a peer named "${name}" is already running`);

		const worktree = await createWorktree(this.exec, repo, ctx.cwd, name);
		try {
			const entries = ctx.sessionManager.getEntries() as unknown as RawEntry[];
			const leafId = ctx.sessionManager.getLeafId();
			const fromId = request.context === "fresh" ? null : safeForkPoint(entries, request.fromId ?? leafId);
			const session = forkSession({
				entries,
				fromId,
				cwd: worktree.path,
				sessionDir: this.sessionDirFor(ctx, worktree.path),
				parentSession: ctx.sessionManager.getSessionFile(),
				version: ctx.sessionManager.getHeader()?.version,
			});
			// The task waits in the peer's inbox and starts its first turn once it has joined.
			hub.forget(name);
			hub.send({ from: id, to: name, text: task, fromEntryId: leafId ?? undefined, fromSessionId: ctx.sessionManager.getSessionId() });
			const logFile = hub.logFile(name);
			const peer = spawnBackgroundPeer({
				name,
				cwd: worktree.path,
				sessionFile: session.file,
				logFile,
				spawnedBy: id,
				forkedFrom: fromId ?? undefined,
				model: request.model,
			});
			const now = Date.now();
			hub.register({
				id: name,
				pid: peer.pid,
				cwd: worktree.path,
				branch: worktree.branch,
				sessionId: session.sessionId,
				sessionFile: session.file,
				status: "working",
				background: true,
				spawnedBy: id,
				forkedFrom: fromId ?? undefined,
				task: task.split("\n")[0]?.slice(0, 200),
				startedAt: now,
				lastSeen: now,
			});
			// The peer has joined once it has taken the task out of its inbox.
			let joined = false;
			for (const deadline = Date.now() + JOIN_TIMEOUT; Date.now() < deadline && peer.child.exitCode === null; ) {
				await new Promise((resolve) => setTimeout(resolve, 250));
				if (!hub.hasPending(name)) {
					joined = true;
					break;
				}
			}
			if (peer.child.exitCode !== null) throw new Error(`the peer process exited right away; see ${logFile}`);
			return {
				name,
				branch: worktree.branch,
				worktree: worktree.path,
				sessionFile: session.file,
				pid: peer.pid,
				dirtySource: worktree.dirtySource,
				joined,
				logFile,
			};
		} catch (error) {
			// The peer never ran, so the new worktree holds no work and can be removed.
			stopBackgroundPeer(name);
			hub.drain(name);
			hub.update(name, { status: "exited" });
			await removeWorktree(this.exec, ctx.cwd, worktree.path);
			await this.exec("git", ["branch", "-d", worktree.branch], { cwd: ctx.cwd }).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Where pi keeps sessions for a peer's worktree. With pi's default layout that is a
	 * directory per working directory. A custom session directory holds all sessions together,
	 * so the peer's session goes next to the current one.
	 */
	private sessionDirFor(ctx: ExtensionContext, cwd: string): string {
		const current = ctx.sessionManager.getSessionDir();
		const usesDefaultLayout = !current || dirname(current) === join(getAgentDir(), "sessions");
		return usesDefaultLayout ? SessionManager.create(cwd).getSessionDir() : current;
	}

	/** Stops a background peer. Its worktree and branch stay. */
	stopPeer(name: string): boolean {
		const peer = this.hub?.get(name);
		if (!peer?.alive || !peer.background) return false;
		// Closing the input pipe covers a peer started by this process; the signal covers one
		// started by another process. pi shuts down in an orderly way for either.
		stopBackgroundPeer(name);
		try {
			process.kill(peer.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		return true;
	}

	/** Removes the record of an exited peer and its worktree if that worktree is clean. */
	async forgetPeer(ctx: ExtensionContext, name: string): Promise<{ forgotten: boolean; worktreeKept?: string }> {
		const hub = this.hub;
		const peer = hub?.get(name);
		if (!hub || !peer || peer.alive) return { forgotten: false };
		let worktreeKept: string | undefined;
		if (peer.background && this.repo && peer.cwd !== this.repo.mainRoot && peer.cwd !== ctx.cwd) {
			const removed = await removeWorktree(this.exec, ctx.cwd, peer.cwd);
			if (!removed.removed) worktreeKept = removed.reason ?? peer.cwd;
		}
		hub.forget(name);
		return { forgotten: true, worktreeKept };
	}

	/** One line per peer, for the model. */
	async describePeers(ctx: ExtensionContext): Promise<string> {
		const peers = this.peers();
		if (peers.length === 0) return "No peers.";
		const lines: string[] = [];
		for (const peer of peers) {
			const parts = [peer.id === this.id ? `${peer.id} (you)` : peer.id, peer.status];
			if (peer.branch) {
				const ahead = peer.id === this.id ? undefined : await commitsAhead(this.exec, ctx.cwd, peer.branch);
				parts.push(ahead === undefined ? `branch ${peer.branch}` : `branch ${peer.branch} (${ahead} commits you do not have)`);
			}
			parts.push(`worktree ${peer.cwd}`);
			if (peer.task) parts.push(`task: ${peer.task}`);
			lines.push(`- ${parts.join(" · ")}`);
		}
		return lines.join("\n");
	}
}
