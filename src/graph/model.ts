/**
 * Grove model: turns one or more pi session files into a single list of graph nodes.
 *
 * A pi session is a tree of entries linked by `parentId`. Forked sessions and peer sessions copy
 * the entries of the path they forked from and keep their ids, so the union of several related
 * session files is still one tree. On top of that tree we add "merge" edges for the places where
 * information from one branch flowed into another: branch summaries and peer messages.
 *
 * This module is pure. It has no dependency on pi or on the terminal.
 */

export interface RawEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface GroveSource {
	sessionId: string;
	sessionFile?: string;
	/** Display name: the peer name, the session name, or undefined. */
	name?: string;
	/** Header timestamp. Used to decide which session created an entry. */
	created: number;
	entries: RawEntry[];
	leafId: string | null;
	isCurrent: boolean;
}

export type NodeKind = "user" | "assistant" | "tool" | "summary" | "compaction" | "peer" | "custom";

/**
 * - `turns`: one row per user prompt, plus summaries, peer messages, labels and branch tips.
 * - `messages`: also every assistant message.
 * - `all`: also tool results and bash executions.
 */
export type FilterMode = "turns" | "messages" | "all";

export const FILTER_MODES: readonly FilterMode[] = ["turns", "messages", "all"];

export interface GroveRef {
	kind: "head" | "tip" | "label";
	text: string;
	/** Session the ref belongs to (head and tip refs). */
	sessionId?: string;
}

export interface GroveNode {
	id: string;
	/** Nearest visible ancestor, or null for a root. */
	parentId: string | null;
	/** Visible nodes whose content flowed into this node (branch summaries, peer messages). */
	mergeParents: string[];
	kind: NodeKind;
	/** Two-letter author tag, lazygit style. */
	author: string;
	/** Stable key for coloring the author tag. */
	authorKey: string;
	subject: string;
	timestamp: number;
	/** Session that created the entry. */
	ownerSession: string;
	/** True when the current session file contains the entry, so it can be navigated to. */
	inCurrent: boolean;
	/** True when the entry is on the path from the current leaf to the root. */
	onActivePath: boolean;
	/** True when this row represents the current leaf. */
	isHead: boolean;
	refs: GroveRef[];
	/** Number of entries folded into this row (hidden entries between it and its visible parent). */
	folded: number;
	entry: RawEntry;
}

export interface Grove {
	/** Newest first. Every node comes before its parent and its merge parents. */
	nodes: GroveNode[];
	byId: Map<string, GroveNode>;
	/** Maps every content entry id to the id of the visible row that represents it. */
	rowOf: Map<string, string>;
}

/** customType of messages delivered between peers. */
export const PEER_MESSAGE_TYPE = "grove-message";

const BOOKKEEPING = new Set([
	"label",
	"session_info",
	"model_change",
	"thinking_level_change",
	"usage",
	"context_edit",
	"custom",
]);

function messageOf(entry: RawEntry): Record<string, unknown> | undefined {
	const message = entry.message;
	return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
}

function roleOf(entry: RawEntry): string | undefined {
	const role = messageOf(entry)?.role;
	return typeof role === "string" ? role : undefined;
}

/** Content entries are the ones worth a row; bookkeeping entries never show. */
export function isContentEntry(entry: RawEntry): boolean {
	if (BOOKKEEPING.has(entry.type)) return false;
	if (entry.type === "message") return roleOf(entry) !== "system";
	if (entry.type === "custom_message") return entry.display !== false;
	return entry.type === "branch_summary" || entry.type === "compaction";
}

export function kindOf(entry: RawEntry): NodeKind {
	if (entry.type === "branch_summary") return "summary";
	if (entry.type === "compaction") return "compaction";
	if (entry.type === "custom_message") return entry.customType === PEER_MESSAGE_TYPE ? "peer" : "custom";
	const role = roleOf(entry);
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	return "tool";
}

/** The first line with text, without the Markdown markers that only add noise in one row. */
function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line
			.trim()
			.replace(/^#{1,6}\s+/, "")
			.replace(/\*\*|__/g, "");
		if (trimmed) return trimmed;
	}
	return "";
}

/** Plain text of a message content value (a string or an array of content blocks). */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
			const text = (block as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

function toolCallSummary(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const names: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall") {
			const name = (block as { name?: unknown }).name;
			if (typeof name === "string") names.push(name);
		}
	}
	if (names.length === 0) return "";
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	return `→ ${[...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name)).join(", ")}`;
}

/**
 * A peer message is stored with a first line that names the sender for the model. The graph
 * shows the sender in the author column, so that line is removed for display.
 */
export function peerMessageBody(content: unknown): string {
	return contentText(content).replace(/^Message from peer "[^"]*":\n\n/, "");
}

export function peerMessageContent(from: string, text: string): string {
	return `Message from peer "${from}":\n\n${text}`;
}

export function subjectOf(entry: RawEntry): string {
	switch (kindOf(entry)) {
		case "summary":
			return `summary: ${firstLine(String(entry.summary ?? ""))}`;
		case "compaction":
			return `compaction: ${firstLine(String(entry.summary ?? ""))}`;
		case "peer":
			return firstLine(peerMessageBody(entry.content)) || "(empty message)";
		case "custom":
			return firstLine(contentText(entry.content)) || `(${String(entry.customType ?? "custom")})`;
		case "user":
			return firstLine(contentText(messageOf(entry)?.content)) || "(empty prompt)";
		case "assistant": {
			const message = messageOf(entry);
			const text = firstLine(contentText(message?.content)) || toolCallSummary(message?.content);
			if (text) return text;
			return typeof message?.errorMessage === "string" ? `error: ${firstLine(message.errorMessage)}` : "(no text)";
		}
		case "tool": {
			const message = messageOf(entry);
			const name = typeof message?.toolName === "string" ? message.toolName : (roleOf(entry) ?? "tool");
			const text = firstLine(contentText(message?.content ?? message?.output));
			return text ? `${name}: ${text}` : name;
		}
	}
}

/** Two letters for the author column: first letter upper case, second lower case. */
export function initials(name: string): string {
	const letters = name.replace(/[^\p{L}\p{N}]/gu, "");
	if (!letters) return "??";
	const first = letters.charAt(0).toUpperCase();
	const second = letters.charAt(1).toLowerCase() || first.toLowerCase();
	return first + second;
}

function authorOf(entry: RawEntry, kind: NodeKind, ownerName: string | undefined): { author: string; key: string } {
	switch (kind) {
		case "user":
			return { author: "Us", key: "user" };
		case "summary":
			return { author: "Su", key: "summary" };
		case "compaction":
			return { author: "Co", key: "compaction" };
		case "tool":
			return { author: "To", key: "tool" };
		case "peer": {
			const from = (entry.details as { from?: unknown } | undefined)?.from;
			const name = typeof from === "string" && from ? from : "peer";
			return { author: initials(name), key: `peer:${name}` };
		}
		case "custom":
			return { author: "Ex", key: "extension" };
		case "assistant": {
			if (ownerName) return { author: initials(ownerName), key: `peer:${ownerName}` };
			const model = messageOf(entry)?.model;
			const name = typeof model === "string" && model ? model : "assistant";
			return { author: initials(name), key: `model:${name}` };
		}
	}
}

function isVisibleKind(kind: NodeKind, filter: FilterMode): boolean {
	if (filter === "all") return true;
	if (kind === "tool") return false;
	if (kind === "assistant") return filter === "messages";
	return true;
}

function mergeSourceOf(entry: RawEntry): string | undefined {
	if (entry.type === "branch_summary") return typeof entry.fromId === "string" ? entry.fromId : undefined;
	if (entry.type === "custom_message" && entry.customType === PEER_MESSAGE_TYPE) {
		const fromEntryId = (entry.details as { fromEntryId?: unknown } | undefined)?.fromEntryId;
		return typeof fromEntryId === "string" ? fromEntryId : undefined;
	}
	return undefined;
}

export interface BuildOptions {
	filter?: FilterMode;
}

export function buildGrove(sources: GroveSource[], options: BuildOptions = {}): Grove {
	const filter = options.filter ?? "turns";
	const current = sources.find((source) => source.isCurrent);
	// Oldest session first: the first session that contains an entry created it.
	const ordered = [...sources].sort((a, b) => a.created - b.created);

	const entries = new Map<string, RawEntry>();
	const owner = new Map<string, GroveSource>();
	const labels = new Map<string, string>();
	const inCurrent = new Set<string>();

	for (const source of ordered) {
		for (const entry of source.entries) {
			if (!entry || typeof entry.id !== "string") continue;
			if (source.isCurrent) inCurrent.add(entry.id);
			if (entry.type === "label" && typeof entry.targetId === "string") {
				// Entries are append-only, so a later label entry replaces an earlier one.
				if (typeof entry.label === "string" && entry.label) labels.set(entry.targetId, entry.label);
				else labels.delete(entry.targetId);
			}
			if (!entries.has(entry.id)) {
				entries.set(entry.id, entry);
				owner.set(entry.id, source);
			}
		}
	}

	// Entries that have a content entry somewhere below them. A content entry that is not in this
	// set is the end of a branch. Bookkeeping entries (labels, usage) below it do not count.
	const hasContentBelow = new Set<string>();
	for (const entry of entries.values()) {
		if (!isContentEntry(entry)) continue;
		let cursor = entry.parentId;
		while (cursor && !hasContentBelow.has(cursor)) {
			hasContentBelow.add(cursor);
			cursor = entries.get(cursor)?.parentId ?? null;
		}
	}

	/** Nearest content entry at or above `id`. */
	const contentAt = (id: string | null | undefined): string | undefined => {
		const seen = new Set<string>();
		let cursor = id ?? null;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const entry = entries.get(cursor);
			if (!entry) return undefined;
			if (isContentEntry(entry)) return entry.id;
			cursor = entry.parentId;
		}
		return undefined;
	};

	const visible = new Set<string>();
	const refs = new Map<string, GroveRef[]>();
	const addRef = (id: string, ref: GroveRef) => {
		const list = refs.get(id);
		if (list) list.push(ref);
		else refs.set(id, [ref]);
	};

	for (const entry of entries.values()) {
		if (!isContentEntry(entry)) continue;
		// The end of every branch is always a row, so a branch never disappears behind a filter.
		if (isVisibleKind(kindOf(entry), filter) || !hasContentBelow.has(entry.id)) visible.add(entry.id);
	}
	for (const [targetId, label] of labels) {
		const target = contentAt(targetId);
		if (!target) continue;
		visible.add(target);
		addRef(target, { kind: "label", text: label });
	}

	let headId: string | undefined;
	for (const source of ordered) {
		const head = contentAt(source.leafId);
		if (!head) continue;
		visible.add(head);
		if (source.isCurrent) {
			headId = head;
			addRef(head, { kind: "head", text: "HEAD", sessionId: source.sessionId });
		} else {
			const text = source.name ?? source.sessionId.slice(0, 8);
			addRef(head, { kind: "tip", text, sessionId: source.sessionId });
		}
	}

	const activePath = new Set<string>();
	{
		let cursor = current?.leafId ?? null;
		while (cursor && !activePath.has(cursor)) {
			activePath.add(cursor);
			cursor = entries.get(cursor)?.parentId ?? null;
		}
	}

	/** Nearest visible entry at or above `id`, with the number of content entries skipped. */
	const visibleAt = (id: string | null | undefined): { id: string | null; skipped: number } => {
		const seen = new Set<string>();
		let cursor = id ?? null;
		let skipped = 0;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			if (visible.has(cursor)) return { id: cursor, skipped };
			const entry = entries.get(cursor);
			if (!entry) break;
			if (isContentEntry(entry)) skipped++;
			cursor = entry.parentId;
		}
		return { id: null, skipped };
	};

	const rowOf = new Map<string, string>();
	const nodes = new Map<string, GroveNode>();
	for (const id of visible) {
		const entry = entries.get(id);
		if (!entry) continue;
		const source = owner.get(id);
		const kind = kindOf(entry);
		const parent = visibleAt(entry.parentId);
		const { author, key } = authorOf(entry, kind, source && sources.length > 1 ? source.name : undefined);
		const time = Date.parse(entry.timestamp);
		nodes.set(id, {
			id,
			parentId: parent.id,
			mergeParents: [],
			kind,
			author,
			authorKey: key,
			subject: subjectOf(entry),
			timestamp: Number.isNaN(time) ? 0 : time,
			ownerSession: source?.sessionId ?? "",
			inCurrent: inCurrent.has(id),
			onActivePath: activePath.has(id),
			isHead: id === headId,
			refs: refs.get(id) ?? [],
			folded: parent.skipped,
			entry,
		});
	}

	// A folded entry is represented by the row of its closest visible descendant: that row is the
	// one whose `folded` count includes it.
	for (const node of nodes.values()) {
		const seen = new Set<string>();
		let cursor: string | null = node.id;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			if (cursor !== node.id && visible.has(cursor)) break;
			if (!rowOf.has(cursor)) rowOf.set(cursor, node.id);
			cursor = entries.get(cursor)?.parentId ?? null;
		}
	}

	for (const node of nodes.values()) {
		const sourceId = mergeSourceOf(node.entry);
		if (!sourceId) continue;
		const target = visibleAt(contentAt(sourceId)).id;
		if (!target || target === node.id || target === node.parentId) continue;
		node.mergeParents.push(target);
	}

	const sorted = sortNewestFirst(nodes);
	return { nodes: sorted, byId: nodes, rowOf };
}

/**
 * Newest first, but never a parent before its child. Kahn's algorithm over the child → parent
 * edges, always emitting the newest node that has no unemitted child. A merge edge that would
 * create a cycle is dropped.
 */
function sortNewestFirst(nodes: Map<string, GroveNode>): GroveNode[] {
	const pendingChildren = new Map<string, number>();
	const parentsOf = (node: GroveNode): string[] => {
		const parents = node.parentId ? [node.parentId] : [];
		for (const id of node.mergeParents) if (nodes.has(id)) parents.push(id);
		return parents;
	};
	for (const node of nodes.values()) {
		for (const parent of parentsOf(node)) pendingChildren.set(parent, (pendingChildren.get(parent) ?? 0) + 1);
	}

	const newer = (a: GroveNode, b: GroveNode) => b.timestamp - a.timestamp || (a.id < b.id ? 1 : -1);
	const ready: GroveNode[] = [];
	const push = (node: GroveNode) => {
		let low = 0;
		let high = ready.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (newer(ready[mid] as GroveNode, node) <= 0) low = mid + 1;
			else high = mid;
		}
		ready.splice(low, 0, node);
	};
	for (const node of nodes.values()) if (!pendingChildren.get(node.id)) push(node);

	const result: GroveNode[] = [];
	const emitted = new Set<string>();
	while (result.length < nodes.size) {
		let next = ready.shift();
		if (!next) {
			// A cycle through merge edges: break it at the newest remaining node.
			const rest = [...nodes.values()].filter((node) => !emitted.has(node.id)).sort(newer);
			next = rest[0];
			if (!next) break;
			for (const node of rest) node.mergeParents = node.mergeParents.filter((id) => id !== (next as GroveNode).id);
			pendingChildren.set(next.id, 0);
		}
		if (emitted.has(next.id)) continue;
		emitted.add(next.id);
		result.push(next);
		for (const parent of parentsOf(next)) {
			if (emitted.has(parent)) continue;
			const left = (pendingChildren.get(parent) ?? 1) - 1;
			pendingChildren.set(parent, left);
			if (left <= 0) push(nodes.get(parent) as GroveNode);
		}
	}
	return result;
}
