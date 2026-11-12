/**
 * The tools every peer has. They are the same for all peers: a peer started in the background
 * can list, message and start peers exactly like the session the user is typing in.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PeerController } from "./controller.ts";

function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

export function registerPeerTools(pi: ExtensionAPI, controller: PeerController): void {
	pi.registerTool({
		name: "grove_peers",
		label: "Grove Peers",
		description:
			"List the peers in this grove: the other pi agents working in this repository, each with its status, branch, worktree and task.",
		promptSnippet: "List the peer agents working in this repository",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!controller.active) throw new Error("peers are off for this repository");
			return text(await controller.describePeers(ctx));
		},
	});

	pi.registerTool({
		name: "grove_spawn",
		label: "Grove Spawn",
		description:
			"Start a new peer: another pi agent with its own git worktree and its own branch grove/<name>, working on the task you give it. The peer runs in the background and reports back with a message. Returns as soon as the peer has started.",
		promptSnippet: "Start a peer agent in its own git worktree to work on a task in parallel",
		parameters: Type.Object({
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
		}),
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
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "grove_send",
		label: "Grove Send",
		description:
			"Send a message to a peer, or to all other peers with to='all'. The message appears in the peer's conversation and wakes it if it is idle.",
		promptSnippet: "Send a message to a peer agent",
		parameters: Type.Object({
			to: Type.String({ description: "Peer name, or 'all'." }),
			message: Type.String({ description: "The message. The peer does not see your conversation, so include what it needs." }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const delivered = controller.send(ctx, params.to.trim(), params.message);
			return text(`Sent to ${delivered.join(", ")}.`);
		},
	});

	pi.registerTool({
		name: "grove_board",
		label: "Grove Board",
		description:
			"Read or post on the grove's shared board: short notes every peer can see, such as decisions, interface contracts and who owns which area.",
		promptSnippet: "Read or post shared notes for all peer agents",
		parameters: Type.Object({
			action: StringEnum(["read", "post"] as const),
			text: Type.Optional(Type.String({ description: "The note to post (for action 'post')." })),
		}),
		async execute(_toolCallId, params) {
			const hub = controller.grove;
			const self = controller.self;
			if (!hub || !self || !controller.active) throw new Error("peers are off for this repository");
			if (params.action === "post") {
				const note = params.text?.trim();
				if (!note) throw new Error("text is required to post");
				hub.postNote(self, note);
				return text("Posted.");
			}
			const notes = hub.notes();
			if (notes.length === 0) return text("The board is empty.");
			return text(notes.map((note) => `[${new Date(note.time).toISOString()}] ${note.from}: ${note.text}`).join("\n"));
		},
	});
}
