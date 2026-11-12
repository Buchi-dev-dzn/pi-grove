/**
 * pi-grove: a lazygit-style graph for pi's session tree, and equal peers that each own a
 * branch of that tree and a git worktree.
 *
 * - `/grove` (alt+g) opens the view: tree, history and peers.
 * - `/grove peers auto|manual|off` sets how eagerly agents use peers.
 * - `/grove spawn|send|stop` manage peers without opening the graph.
 */

import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { buildGrove, isContentEntry, PEER_MESSAGE_TYPE, peerMessageBody, type RawEntry, subjectOf } from "./graph/model.ts";
import { layoutNodes } from "./graph/render.ts";
import { findRelatedSessions, loadSources, type OtherSession } from "./graph/sessions.ts";
import { type MessageDetails, PeerController } from "./peers/controller.ts";
import { PEER_MODES, type PeerMode } from "./peers/hub.ts";
import { grovePrompt } from "./peers/prompt.ts";
import { registerPeerTools } from "./peers/tools.ts";
import { Reflog } from "./reflog/journal.ts";
import { exchange, GLYPH_RECEIVED } from "./ui/chat.ts";
import { GroveView, initialState, type ReflogRow, type ViewAction, type ViewData, type ViewState } from "./ui/grove-view.ts";

const FLAG_PEERS = "grove-peers";
const PROMPT_SECTION = "grove";

// Set while an instance of this extension is active in the process. A second copy, loaded from
// another path in the same session, would register every tool and command twice.
const ACTIVE = Symbol.for("pi-grove.active");

export default function groveExtension(pi: ExtensionAPI): void {
	const holder = globalThis as { [ACTIVE]?: boolean };
	if (holder[ACTIVE]) return;
	holder[ACTIVE] = true;

	const controller = new PeerController(pi);
	const reflog = new Reflog(join(getAgentDir(), "pi-grove", "reflog"));

	registerPeerTools(pi, controller);

	pi.registerFlag(FLAG_PEERS, {
		description: "Peer mode for this run: auto, manual or off (overrides the repository's setting)",
		type: "string",
	});

	pi.registerMessageRenderer<MessageDetails>(PEER_MESSAGE_TYPE, (message, options, theme) =>
		exchange(theme, {
			glyph: GLYPH_RECEIVED,
			name: message.details?.from ?? "peer",
			// The stored content starts with a line that names the sender for the model.
			body: peerMessageBody(message.content),
			expanded: options.expanded,
			expandHint: options.keyHint("app.tools.expand", "to expand"),
			outputPad: options.outputPad,
		}),
	);

	// ── session events ───────────────────────────────────────────────────────

	pi.on("session_start", async (event, ctx) => {
		const flag = pi.getFlag(FLAG_PEERS);
		await controller.start(ctx, typeof flag === "string" ? flag : undefined);
		reflog.recordStart(ctx.sessionManager.getSessionId(), ctx.sessionManager.getLeafId(), event.reason);
	});

	pi.on("session_tree", (event, ctx) => {
		reflog.recordMove(ctx.sessionManager.getSessionId(), event.oldLeafId, event.newLeafId, event.summaryEntry !== undefined);
	});

	pi.on("session_shutdown", (event) => {
		controller.stop(event.reason === "quit");
		// The next session creates a new instance of this extension.
		holder[ACTIVE] = false;
	});

	pi.on("agent_start", () => controller.setStatus("working"));
	pi.on("agent_settled", () => controller.setStatus("idle"));

	pi.on("before_agent_start", (event, ctx) => {
		const sections = (event.systemPromptOptions.sections ??= {});
		const self = controller.self;
		if (!controller.active || !self) {
			delete sections[PROMPT_SECTION];
			return;
		}
		const config = controller.config();
		const record = controller.grove?.get(self);
		sections[PROMPT_SECTION] = grovePrompt({
			self,
			mode: config.mode,
			maxPeers: config.maxPeers,
			cwd: ctx.cwd,
			branch: controller.repository?.branch,
			spawnedBy: record?.background ? record.spawnedBy : undefined,
		});
	});

	// ── data for the view ────────────────────────────────────────────────────

	function loadData(ctx: ExtensionContext, state: ViewState): ViewData {
		const manager = ctx.sessionManager;
		const entries = manager.getEntries() as unknown as RawEntry[];
		const sessionFile = manager.getSessionFile();
		const sessionId = manager.getSessionId();
		const peers = controller.peers();

		const others: OtherSession[] = [];
		if (state.related) {
			// Peer sessions come first so that their names win over the plain session names.
			for (const peer of peers) {
				if (peer.sessionFile && peer.sessionId !== sessionId) others.push({ file: peer.sessionFile, name: peer.id });
			}
			if (sessionFile) for (const file of findRelatedSessions(sessionFile, [])) others.push({ file });
		}
		const created = Date.parse(manager.getHeader()?.timestamp ?? "");
		const sources = loadSources(
			{
				sessionId,
				sessionFile,
				created: Number.isNaN(created) ? 0 : created,
				name: controller.self ?? pi.getSessionName(),
				entries,
				leafId: manager.getLeafId(),
			},
			others,
		);
		const grove = buildGrove(sources, { filter: state.filter });

		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const reflogRows: ReflogRow[] = reflog
			.read(sessionId)
			.reverse()
			.map((entry) => {
				let target = entry.to ? byId.get(entry.to) : undefined;
				const reachable = entry.to === null || target !== undefined;
				// Describe the position by the nearest entry with content.
				while (target && !isContentEntry(target)) target = target.parentId ? byId.get(target.parentId) : undefined;
				// A position with no content above it is the start of the session, before any prompt.
				return { entry, reachable, subject: target ? subjectOf(target) : reachable ? "(start of session)" : "" };
			});

		const config = controller.config();
		return {
			grove,
			layout: layoutNodes(grove.nodes),
			reflog: reflogRows,
			sessionCount: sources.length,
			peers: {
				available: controller.grove !== undefined,
				self: controller.self,
				mode: config.mode,
				maxPeers: config.maxPeers,
				peers,
				messages: controller.grove?.messages() ?? [],
				notes: controller.grove?.notes() ?? [],
			},
		};
	}

	// ── actions ──────────────────────────────────────────────────────────────

	function errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	async function askAndSpawn(ctx: ExtensionCommandContext, fromId: string | undefined): Promise<string | undefined> {
		if (!controller.active) return "peers are off; turn them on with: /grove peers auto";
		const name = await ctx.ui.input("Peer name", "short name, e.g. api");
		if (!name?.trim()) return undefined;
		const task = await ctx.ui.editor(`Task for peer "${name.trim()}"`, "");
		if (!task?.trim()) return undefined;
		try {
			const result = await controller.spawn(ctx, { name: name.trim(), task, fromId });
			return result.joined ? `started peer ${result.name} on ${result.branch}` : `peer ${result.name} started but has not joined yet; log: ${result.logFile}`;
		} catch (error) {
			return `could not start the peer: ${errorText(error)}`;
		}
	}

	async function cycleMode(ctx: ExtensionContext): Promise<string> {
		const current = controller.config().mode;
		const next = PEER_MODES[(PEER_MODES.indexOf(current) + 1) % PEER_MODES.length] ?? "manual";
		try {
			await controller.setMode(ctx, next);
			return `peer mode: ${next}`;
		} catch (error) {
			return errorText(error);
		}
	}

	/**
	 * Performs one action from the view. Returns true when the view should open again, and
	 * false when the action moved to another place or session and the view should stay closed.
	 */
	async function perform(ctx: ExtensionCommandContext, state: ViewState, action: ViewAction): Promise<boolean> {
		switch (action.type) {
			case "close":
				return false;
			case "navigate": {
				if (!ctx.isIdle()) {
					state.notice = "the agent is still working; wait for it to finish, then jump";
					return true;
				}
				try {
					await ctx.navigateTree(action.id, { summarize: action.summarize });
					return false;
				} catch (error) {
					state.notice = `could not jump: ${errorText(error)}`;
					return true;
				}
			}
			case "fork": {
				const entry = ctx.sessionManager.getEntry(action.id) as unknown as RawEntry | undefined;
				const isPrompt = (entry?.message as { role?: unknown } | undefined)?.role === "user";
				try {
					// A session switch replaces this context; nothing after it may use `ctx`.
					const result = await ctx.fork(action.id, { position: isPrompt ? "before" : "at" });
					if (!result.cancelled) return false;
					state.notice = "fork cancelled";
				} catch (error) {
					state.notice = `could not fork: ${errorText(error)}`;
				}
				return true;
			}
			case "label": {
				const label = await ctx.ui.input("Label (empty to clear)", action.current ?? "");
				if (label !== undefined) {
					pi.setLabel(action.id, label.trim() || undefined);
					state.notice = label.trim() ? `labelled ${action.id.slice(0, 8)}` : "label cleared";
				}
				return true;
			}
			case "spawn":
				state.notice = await askAndSpawn(ctx, action.id);
				return true;
			case "peer-message": {
				const text = await ctx.ui.editor(`Message to ${action.peer}`, "");
				if (text?.trim()) {
					try {
						controller.send(ctx, action.peer, text.trim());
						state.notice = `sent to ${action.peer}`;
					} catch (error) {
						state.notice = errorText(error);
					}
				}
				return true;
			}
			case "peer-stop": {
				if (await ctx.ui.confirm(`Stop peer ${action.peer}?`, "Its worktree and branch are kept.")) {
					state.notice = controller.stopPeer(action.peer) ? `stopping ${action.peer}` : `could not stop ${action.peer}`;
				}
				return true;
			}
			case "peer-forget":
			case "peer-mode":
				state.notice = await performInline(ctx, action);
				return true;
		}
	}

	/** Actions that need no dialog. The view runs them without closing. */
	async function performInline(ctx: ExtensionContext, action: ViewAction): Promise<string | undefined> {
		if (action.type === "peer-mode") return cycleMode(ctx);
		if (action.type !== "peer-forget") return undefined;
		const result = await controller.forgetPeer(ctx, action.peer);
		if (!result.forgotten) return `${action.peer} is still running`;
		if (result.worktreeKept) return `forgot ${action.peer}; its worktree was kept: ${result.worktreeKept}`;
		return `forgot ${action.peer}; its branch is kept`;
	}

	async function openView(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/grove needs the interactive terminal UI", "error");
			return;
		}
		const state = initialState();
		for (;;) {
			const action = await ctx.ui.custom<ViewAction>(
				(tui, theme, _keybindings, done) =>
					new GroveView({
						state,
						theme,
						done,
						load: (current) => loadData(ctx, current),
						inline: (action) => performInline(ctx, action),
						rows: () => tui.terminal.rows - 2,
						requestRender: () => tui.requestRender(),
					}),
				{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } },
			);
			if (!action || !(await perform(ctx, state, action))) return;
		}
	}

	// ── command and shortcut ─────────────────────────────────────────────────

	const SUBCOMMANDS = [
		{ value: "peers", label: "peers", description: "peers [auto|manual|off] [global]: show or set the peer mode" },
		{ value: "spawn", label: "spawn", description: "spawn <name> <task>: start a peer in its own worktree" },
		{ value: "send", label: "send", description: "send <peer|all> <message>" },
		{ value: "stop", label: "stop", description: "stop <peer>: stop a background peer" },
	];

	pi.registerCommand("grove", {
		description: "Open the session tree as a graph (tree, history, peers)",
		getArgumentCompletions: (prefix) => {
			if (prefix.includes(" ")) return null;
			const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [command, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!command) return openView(ctx);
			try {
				if (command === "peers") {
					const mode = rest[0];
					if (!mode) {
						const config = controller.config();
						const names = controller.peers().filter((peer) => peer.alive).map((peer) => peer.id);
						ctx.ui.notify(
							controller.grove
								? `peer mode: ${config.mode} · live peers: ${names.join(", ") || "none"} (limit ${config.maxPeers})`
								: "peers need a git repository",
							"info",
						);
					} else if (PEER_MODES.includes(mode as PeerMode) && rest[1] === "global") {
						const applied = controller.setDefaultMode(ctx, mode as PeerMode);
						const here = applied || !controller.grove ? "" : ` · this repository keeps its own mode: ${controller.config().mode}`;
						ctx.ui.notify(`default peer mode for all repositories: ${mode}${here}`, "info");
					} else if (PEER_MODES.includes(mode as PeerMode) && rest[1] === undefined) {
						await controller.setMode(ctx, mode as PeerMode);
						ctx.ui.notify(`peer mode for this repository: ${mode}`, "info");
					} else ctx.ui.notify("usage: /grove peers [auto|manual|off] [global]", "error");
				} else if (command === "spawn") {
					const [name, ...task] = rest;
					if (!name || task.length === 0) return ctx.ui.notify("usage: /grove spawn <name> <task>", "error");
					const result = await controller.spawn(ctx, { name, task: task.join(" ") });
					if (result.joined) ctx.ui.notify(`started peer ${result.name} on ${result.branch} in ${result.worktree}`, "info");
					else ctx.ui.notify(`peer ${result.name} started but has not joined yet; log: ${result.logFile}`, "warning");
				} else if (command === "send") {
					const [to, ...message] = rest;
					if (!to || message.length === 0) return ctx.ui.notify("usage: /grove send <peer|all> <message>", "error");
					ctx.ui.notify(`sent to ${controller.send(ctx, to, message.join(" ")).join(", ")}`, "info");
				} else if (command === "stop") {
					const name = rest[0];
					if (!name) return ctx.ui.notify("usage: /grove stop <peer>", "error");
					ctx.ui.notify(controller.stopPeer(name) ? `stopping ${name}` : `no running background peer named ${name}`, "info");
				} else ctx.ui.notify("usage: /grove [peers|spawn|send|stop]", "error");
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
		},
	});

	pi.registerShortcut("alt+g", {
		description: "Open the grove (session tree graph)",
		handler: (ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("the agent is working; run /grove when it is idle", "info");
				return;
			}
			// Only commands may move within the session tree, so the shortcut runs the command.
			pi.sendUserMessage("/grove", { expandPromptTemplates: true });
		},
	});
}
