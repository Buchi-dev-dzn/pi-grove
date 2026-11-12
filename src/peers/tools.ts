/**
 * The tools every peer has. They are the same for all peers: a peer started in the background
 * can list, message and start peers exactly like the session the user is typing in.
 *
 * Each tool draws itself in the conversation as part of an exchange between peers instead of
 * as a generic tool call. See `ui/chat.ts`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	empty,
	exchange,
	GLYPH_BOARD,
	GLYPH_PEERS,
	GLYPH_SENT,
	GLYPH_SPAWN,
	peerColor,
	shortPath,
	statusLine,
} from "../ui/chat.ts";
import type { PeerController, SpawnResult } from "./controller.ts";
import { type BoardNote, toPeerName } from "./hub.ts";

interface PeerSummary {
	id: string;
	self: boolean;
	alive: boolean;
	status: string;
	branch?: string;
	task?: string;
}

interface PeersDetails {
	peers: PeerSummary[];
}

interface SendDetails {
	delivered: string[];
}

interface BoardDetails {
	notes?: BoardNote[];
}

interface ResultLike {
	content: { type: string; text?: string }[];
}

function reply<T>(value: string, details: T) {
	return { content: [{ type: "text" as const, text: value }], details };
}

function resultText(result: ResultLike): string {
	return result.content
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("\n")
		.trim();
}

/** The line shown when a tool failed. */
function failure(theme: Theme, result: ResultLike, outputPad: number): Component {
	return statusLine(theme, "error", resultText(result).split("\n")[0] || "failed", outputPad);
}

export function registerPeerTools(pi: ExtensionAPI, controller: PeerController): void {
	pi.registerTool<ReturnType<typeof Type.Object<{}>>, PeersDetails | undefined>({
		name: "grove_peers",
		label: "Grove Peers",
		description:
			"List the peers in this grove: the other pi agents working in this repository, each with its status, branch, worktree and task.",
		promptSnippet: "List the peer agents working in this repository",
		parameters: Type.Object({}),
		renderShell: "self",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!controller.active) throw new Error("peers are off for this repository");
			const peers = controller.peers().map((peer) => ({
				id: peer.id,
				self: peer.id === controller.self,
				alive: peer.alive,
				status: peer.status,
				branch: peer.branch,
				task: peer.task,
			}));
			return reply(await controller.describePeers(ctx), { peers });
		},
		renderCall(_args, theme, context) {
			return exchange(theme, { glyph: GLYPH_PEERS, name: "peers", isPeer: false, expanded: false, outputPad: context.outputPad });
		},
		renderResult(result, options, theme, context) {
			if (context.isError) return failure(theme, result, context.outputPad);
			if (options.isPartial) return empty();
			const peers = result.details?.peers;
			// A result stored by an earlier version has no details; show its text.
			if (!peers) return new Text(theme.fg("dim", resultText(result)), context.outputPad + 2, 0);
			if (peers.length === 0) return statusLine(theme, "plain", "no peers", context.outputPad);
			const lines = peers.map((peer) => {
				const mark = !peer.alive ? theme.fg("dim", "○") : peer.status === "working" ? theme.fg("warning", "●") : theme.fg("success", "●");
				const parts = [mark, theme.bold(peerColor(peer.id)) + (peer.self ? theme.fg("dim", " (you)") : ""), theme.fg("muted", peer.status)];
				if (peer.branch) parts.push(theme.fg("accent", peer.branch));
				if (peer.task && options.expanded) parts.push(theme.fg("dim", peer.task));
				return parts.join("  ");
			});
			return new Text(lines.join("\n"), context.outputPad + 2, 0);
		},
	});

	const spawnParameters = Type.Object({
		name: Type.String({ description: "Short name for the peer, used for its branch: lowercase letters, digits and hyphens, e.g. 'api' or 'try-sqlite'." }),
		task: Type.String({
			description: "The complete task: goal, the files or area the peer owns, what is out of scope, and how to verify the result.",
		}),
		context: Type.Optional(
			StringEnum(["fork", "fresh"] as const, {
				description: "'fork' (default) gives the peer this conversation up to your current turn. 'fresh' starts it with only the task.",
			}),
		),
		model: Type.Optional(Type.String({ description: "Model for the peer, as 'provider/id'. Defaults to the configured default model." })),
	});

	pi.registerTool<typeof spawnParameters, SpawnResult | undefined>({
		name: "grove_spawn",
		label: "Grove Spawn",
		description:
			"Start a new peer: another pi agent with its own git worktree and its own branch grove/<name>, working on the task you give it. The peer runs in the background and reports back with a message. Returns as soon as the peer has started.",
		promptSnippet: "Start a peer agent in its own git worktree to work on a task in parallel",
		parameters: spawnParameters,
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await controller.spawn(ctx, { ...params, context: params.context === "fresh" ? "fresh" : "fork" });
			const lines = [
				`Started peer "${result.name}".`,
				`branch: ${result.branch}`,
				`worktree: ${result.worktree}`,
				"It has its task and will report with a message. Continue with your own work.",
			];
			if (!result.joined) {
				lines.push(`Warning: the peer has not picked up its task yet. If no report arrives, check its log: ${result.logFile}`);
			}
			if (result.dirtySource) {
				lines.push("Note: your checkout has uncommitted changes. The peer's worktree starts from the last commit and does not contain them.");
			}
			return reply(lines.join("\n"), result);
		},
		renderCall(args, theme, context) {
			return exchange(theme, {
				glyph: GLYPH_SPAWN,
				name: toPeerName(args.name ?? ""),
				note: args.context === "fresh" ? "new peer, fresh context" : "new peer",
				body: args.task,
				expanded: context.expanded,
				expandHint: context.keyHint("app.tools.expand", "to expand"),
				outputPad: context.outputPad,
			});
		},
		renderResult(result, options, theme, context) {
			if (context.isError) return failure(theme, result, context.outputPad);
			if (options.isPartial) return statusLine(theme, "plain", "starting…", context.outputPad);
			const details = result.details;
			if (!details) {
				// A result stored by an earlier version: its text has the branch and the worktree.
				const text = resultText(result);
				const branch = /^branch: (.+)$/m.exec(text)?.[1];
				const worktree = /^worktree: (.+)$/m.exec(text)?.[1];
				return statusLine(theme, "ok", [branch, worktree ? shortPath(worktree) : undefined].filter(Boolean).join(" · ") || "started", context.outputPad);
			}
			const container = new Container();
			container.addChild(statusLine(theme, "ok", `${details.branch} · ${shortPath(details.worktree)}`, context.outputPad));
			if (!details.joined) {
				container.addChild(statusLine(theme, "warning", `has not picked up its task yet; log: ${shortPath(details.logFile)}`, context.outputPad));
			}
			if (details.dirtySource) {
				container.addChild(statusLine(theme, "warning", "your uncommitted changes are not in its worktree", context.outputPad));
			}
			return container;
		},
	});

	const sendParameters = Type.Object({
		to: Type.String({ description: "Peer name, or 'all'." }),
		message: Type.String({ description: "The message. The peer does not see your conversation, so include what it needs." }),
	});

	pi.registerTool<typeof sendParameters, SendDetails | undefined>({
		name: "grove_send",
		label: "Grove Send",
		description:
			"Send a message to a peer, or to all other peers with to='all'. The message appears in the peer's conversation and wakes it if it is idle.",
		promptSnippet: "Send a message to a peer agent",
		parameters: sendParameters,
		renderShell: "self",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const delivered = controller.send(ctx, params.to.trim(), params.message);
			return reply(`Sent to ${delivered.join(", ")}.`, { delivered });
		},
		renderCall(args, theme, context) {
			const to = (args.to ?? "").trim();
			return exchange(theme, {
				glyph: GLYPH_SENT,
				name: to,
				isPeer: to !== "all",
				body: args.message,
				expanded: context.expanded,
				expandHint: context.keyHint("app.tools.expand", "to expand"),
				outputPad: context.outputPad,
			});
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return failure(theme, result, context.outputPad);
			// The header already names the receiver; only a broadcast needs the list.
			const delivered = result.details?.delivered;
			if (context.args.to?.trim() === "all" && delivered) {
				return statusLine(theme, "plain", `delivered to ${delivered.join(", ")}`, context.outputPad);
			}
			return empty();
		},
	});

	const boardParameters = Type.Object({
		action: StringEnum(["read", "post"] as const),
		text: Type.Optional(Type.String({ description: "The note to post (for action 'post')." })),
	});

	pi.registerTool<typeof boardParameters, BoardDetails | undefined>({
		name: "grove_board",
		label: "Grove Board",
		description:
			"Read or post on the grove's shared board: short notes every peer can see, such as decisions, interface contracts and who owns which area.",
		promptSnippet: "Read or post shared notes for all peer agents",
		parameters: boardParameters,
		renderShell: "self",
		async execute(_toolCallId, params) {
			const hub = controller.grove;
			const self = controller.self;
			if (!hub || !self || !controller.active) throw new Error("peers are off for this repository");
			if (params.action === "post") {
				const note = params.text?.trim();
				if (!note) throw new Error("text is required to post");
				hub.postNote(self, note);
				return reply("Posted.", {});
			}
			const notes = hub.notes();
			if (notes.length === 0) return reply("The board is empty.", { notes });
			return reply(notes.map((note) => `[${new Date(note.time).toISOString()}] ${note.from}: ${note.text}`).join("\n"), { notes });
		},
		renderCall(args, theme, context) {
			const posting = args.action === "post";
			return exchange(theme, {
				glyph: GLYPH_BOARD,
				name: "board",
				isPeer: false,
				note: posting ? "note for all peers" : "read",
				body: posting ? args.text : undefined,
				expanded: context.expanded,
				expandHint: context.keyHint("app.tools.expand", "to expand"),
				outputPad: context.outputPad,
			});
		},
		renderResult(result, options, theme, context) {
			if (context.isError) return failure(theme, result, context.outputPad);
			if (context.args.action === "post" || options.isPartial) return empty();
			const notes = result.details?.notes;
			if (!notes) return new Text(theme.fg("dim", resultText(result)), context.outputPad + 2, 0);
			if (notes.length === 0) return statusLine(theme, "plain", "empty", context.outputPad);
			const shown = options.expanded ? notes : notes.slice(-3);
			const lines = shown.map((note) => `${theme.bold(peerColor(note.from))}  ${note.text.split("\n")[0] ?? ""}`);
			if (shown.length < notes.length) {
				lines.unshift(theme.fg("dim", `… ${notes.length - shown.length} earlier (${context.keyHint("app.tools.expand", "to expand")})`));
			}
			return new Text(lines.join("\n"), context.outputPad + 2, 0);
		},
	});
}
