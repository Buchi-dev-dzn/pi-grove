/**
 * The grove view: a lazygit-style panel over pi's session tree.
 *
 *    1 Tree   2 History   3 Peers
 *   ╭─ Tree · turns · 3 sessions ──────────────────╮╭─ Preview ───────╮
 *   │ a1b2c3d4 Us ◉ (HEAD) refactor the parser      ││ ...             │
 *   │ 9f8e7d6c Su ●─╮ summary: tried the other way  ││                 │
 *   │ 5d4c3b2a Cl │ ○ (api) api done                ││                 │
 *   ╰───────────────────────────────────────────────╯╰─────────────────╯
 *
 * The view only reads data and reports what the user asked for as a `ViewAction`. The command
 * that opened it performs the action, because only commands may move within the session tree.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { GraphRow } from "../graph/layout.ts";
import { contentText, FILTER_MODES, type FilterMode, type Grove, type GroveNode, peerMessageBody } from "../graph/model.ts";
import { renderRow, type Segment } from "../graph/render.ts";
import type { BoardNote, PeerMessage, PeerMode, PeerView } from "../peers/hub.ts";
import type { ReflogEntry } from "../reflog/journal.ts";
import { hash, paletteColor as color } from "./chat.ts";

export type Tab = "commits" | "reflog" | "peers";

const TABS: readonly Tab[] = ["commits", "reflog", "peers"];
const TAB_TITLES: Record<Tab, string> = { commits: "Tree", reflog: "History", peers: "Peers" };

/** How each kind of recorded move is named in the History tab. */
const MOVE_LABELS: Record<ReflogEntry["kind"], string> = {
	start: "opened at",
	advance: "left",
	move: "jumped to",
	summarize: "summarized",
};

/** View state that survives closing and reopening the view around a dialog. */
export interface ViewState {
	tab: Tab;
	filter: FilterMode;
	/** Include forks, parent sessions and peer sessions in the graph. */
	related: boolean;
	selectedId?: string;
	reflogIndex: number;
	peerIndex: number;
	search: string;
	/** One-line notice shown at the bottom, for example the result of the last action. */
	notice?: string;
}

export function initialState(): ViewState {
	return { tab: "commits", filter: "turns", related: true, reflogIndex: 0, peerIndex: 0, search: "" };
}

export interface ReflogRow {
	entry: ReflogEntry;
	/** Subject of the entry the leaf moved to, when it still exists. */
	subject: string;
	/** False when the target is no longer in the session. */
	reachable: boolean;
}

export interface PeersData {
	/** False when the working directory is not a git repository, so there is no hub. */
	available: boolean;
	self?: string;
	mode: PeerMode;
	maxPeers: number;
	peers: PeerView[];
	messages: PeerMessage[];
	notes: BoardNote[];
}

export interface ViewData {
	grove: Grove;
	layout: GraphRow[];
	/** Newest first. */
	reflog: ReflogRow[];
	peers: PeersData;
	sessionCount: number;
}

export type ViewAction =
	| { type: "close" }
	| { type: "navigate"; id: string; summarize: boolean }
	| { type: "fork"; id: string }
	| { type: "label"; id: string; current?: string }
	| { type: "spawn"; id?: string }
	| { type: "peer-message"; peer: string }
	| { type: "peer-stop"; peer: string }
	| { type: "peer-forget"; peer: string }
	| { type: "peer-mode" };

export interface ViewOptions {
	state: ViewState;
	load: (state: ViewState) => ViewData;
	theme: Theme;
	/** Terminal rows available to the view. */
	rows: () => number;
	requestRender: () => void;
	done: (action: ViewAction) => void;
	/**
	 * Performs an action that needs no dialog while the view stays open, and returns a notice.
	 * Used for `peer-mode` and `peer-forget`.
	 */
	inline: (action: ViewAction) => Promise<string | undefined>;
}

/** Truncates or pads a styled line to exactly `width` columns. */
function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const cut = truncateToWidth(text, width, "…");
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function ago(time: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

function isPrintable(data: string): boolean {
	if (!data || data.startsWith("\x1b")) return false;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return false;
	}
	return true;
}

export class GroveView implements Component {
	readonly capturesViewportInput = true;

	private readonly options: ViewOptions;
	private readonly state: ViewState;
	private data: ViewData;
	private scroll: Record<Tab, number> = { commits: 0, reflog: 0, peers: 0 };
	private searching = false;
	private help = false;

	constructor(options: ViewOptions) {
		this.options = options;
		this.state = options.state;
		this.data = options.load(this.state);
		this.restoreSelection();
	}

	invalidate(): void {}

	private get theme(): Theme {
		return this.options.theme;
	}

	private reload(): void {
		this.data = this.options.load(this.state);
		this.restoreSelection();
	}

	/** Keeps the selection on the same entry after the rows changed, or moves it to HEAD. */
	private restoreSelection(): void {
		const { grove } = this.data;
		const wanted = this.state.selectedId;
		const row = wanted ? (grove.byId.has(wanted) ? wanted : grove.rowOf.get(wanted)) : undefined;
		this.state.selectedId = row ?? grove.nodes.find((node) => node.isHead)?.id ?? grove.nodes[0]?.id;
		this.state.reflogIndex = Math.min(this.state.reflogIndex, Math.max(0, this.data.reflog.length - 1));
		this.state.peerIndex = Math.min(this.state.peerIndex, Math.max(0, this.data.peers.peers.length - 1));
	}

	private get selectedIndex(): number {
		const index = this.data.grove.nodes.findIndex((node) => node.id === this.state.selectedId);
		return index === -1 ? 0 : index;
	}

	private get selectedNode(): GroveNode | undefined {
		return this.data.grove.nodes[this.selectedIndex];
	}

	private count(tab: Tab): number {
		if (tab === "commits") return this.data.grove.nodes.length;
		if (tab === "reflog") return this.data.reflog.length;
		return this.data.peers.peers.length;
	}

	private cursor(tab: Tab): number {
		if (tab === "commits") return this.selectedIndex;
		return tab === "reflog" ? this.state.reflogIndex : this.state.peerIndex;
	}

	private moveTo(index: number): void {
		const tab = this.state.tab;
		const clamped = Math.max(0, Math.min(this.count(tab) - 1, index));
		if (tab === "commits") this.state.selectedId = this.data.grove.nodes[clamped]?.id;
		else if (tab === "reflog") this.state.reflogIndex = clamped;
		else this.state.peerIndex = clamped;
	}

	// ── input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		this.state.notice = undefined;
		if (this.searching) this.handleSearchInput(data);
		else this.handleKey(data);
		this.options.requestRender();
	}

	private handleSearchInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.searching = false;
			this.state.search = "";
		} else if (matchesKey(data, "enter")) {
			this.searching = false;
			this.findNext(1, true);
		} else if (matchesKey(data, "backspace")) {
			this.state.search = [...this.state.search].slice(0, -1).join("");
		} else if (isPrintable(data)) {
			this.state.search += data;
		}
	}

	private matches(node: GroveNode): boolean {
		const query = this.state.search.toLowerCase();
		if (!query) return false;
		return (
			node.subject.toLowerCase().includes(query) ||
			node.id.toLowerCase().startsWith(query) ||
			node.refs.some((ref) => ref.text.toLowerCase().includes(query))
		);
	}

	private findNext(direction: 1 | -1, includeCurrent = false): void {
		const nodes = this.data.grove.nodes;
		if (!this.state.search || nodes.length === 0) return;
		const start = this.selectedIndex;
		for (let step = includeCurrent ? 0 : 1; step <= nodes.length; step++) {
			const index = (((start + direction * step) % nodes.length) + nodes.length) % nodes.length;
			const node = nodes[index];
			if (node && this.matches(node)) {
				this.state.selectedId = node.id;
				return;
			}
		}
		this.state.notice = `no match for "${this.state.search}"`;
	}

	private handleKey(data: string): void {
		if (this.help) {
			this.help = false;
			return;
		}
		const tab = this.state.tab;
		const page = Math.max(1, this.listHeight() - 1);

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			if (this.state.search) this.state.search = "";
			else this.options.done({ type: "close" });
		} else if (data === "?") this.help = true;
		else if (matchesKey(data, "up") || data === "k") this.moveTo(this.cursor(tab) - 1);
		else if (matchesKey(data, "down") || data === "j") this.moveTo(this.cursor(tab) + 1);
		else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.moveTo(this.cursor(tab) - page);
		else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.moveTo(this.cursor(tab) + page);
		else if (matchesKey(data, "home") || data === "g") this.moveTo(0);
		else if (matchesKey(data, "end") || data === "G") this.moveTo(this.count(tab) - 1);
		else if (matchesKey(data, "tab") || matchesKey(data, "right") || data === "]") this.switchTab(1);
		else if (matchesKey(data, "shift+tab") || matchesKey(data, "left") || data === "[") this.switchTab(-1);
		else if (data === "1" || data === "2" || data === "3") this.state.tab = TABS[Number(data) - 1] ?? tab;
		else if (data === "r") this.reload();
		else if (tab === "commits") this.handleCommitsKey(data);
		else if (tab === "reflog") this.handleReflogKey(data);
		else this.handlePeersKey(data);
	}

	private switchTab(direction: 1 | -1): void {
		const index = TABS.indexOf(this.state.tab);
		this.state.tab = TABS[(index + direction + TABS.length) % TABS.length] ?? "commits";
	}

	private handleCommitsKey(data: string): void {
		const node = this.selectedNode;
		if (data === "t") {
			const index = FILTER_MODES.indexOf(this.state.filter);
			this.state.filter = FILTER_MODES[(index + 1) % FILTER_MODES.length] ?? "turns";
			this.reload();
		} else if (data === "a") {
			this.state.related = !this.state.related;
			this.reload();
		} else if (data === "/") {
			this.searching = true;
			this.state.search = "";
		} else if (data === "n") this.findNext(1);
		else if (data === "N") this.findNext(-1);
		else if (data === "H") {
			this.state.selectedId = this.data.grove.nodes.find((candidate) => candidate.isHead)?.id ?? this.state.selectedId;
		} else if (!node) return;
		else if (data === "p") this.options.done({ type: "spawn", id: node.inCurrent ? node.id : undefined });
		else if (!node.inCurrent) {
			if (matchesKey(data, "enter") || ["s", "f", "l"].includes(data)) {
				this.state.notice = "this entry belongs to another session; it is shown read-only";
			}
		} else if (matchesKey(data, "enter")) this.options.done({ type: "navigate", id: node.id, summarize: false });
		else if (data === "s") this.options.done({ type: "navigate", id: node.id, summarize: true });
		else if (data === "f") this.options.done({ type: "fork", id: node.id });
		else if (data === "l") {
			const current = node.refs.find((ref) => ref.kind === "label")?.text;
			this.options.done({ type: "label", id: node.id, current });
		}
	}

	private handleReflogKey(data: string): void {
		const row = this.data.reflog[this.state.reflogIndex];
		if (!row || !matchesKey(data, "enter")) return;
		if (!row.reachable || !row.entry.to) this.state.notice = "that position is no longer in this session";
		else this.options.done({ type: "navigate", id: row.entry.to, summarize: false });
	}

	private handlePeersKey(data: string): void {
		const peers = this.data.peers;
		if (!peers.available) return;
		const peer = peers.peers[this.state.peerIndex];
		if (data === "o") this.runInline({ type: "peer-mode" });
		else if (data === "n" || data === "p") this.options.done({ type: "spawn" });
		else if (!peer) return;
		else if (data === "m") {
			if (peer.id === peers.self) this.state.notice = "that is this session";
			else if (!peer.alive) this.state.notice = `${peer.id} is not running`;
			else this.options.done({ type: "peer-message", peer: peer.id });
		} else if (data === "x") {
			if (!peer.alive) this.state.notice = `${peer.id} is not running`;
			else if (!peer.background) this.state.notice = "only background peers can be stopped from here";
			else this.options.done({ type: "peer-stop", peer: peer.id });
		} else if (data === "d") {
			if (peer.alive) this.state.notice = `${peer.id} is still running`;
			else this.runInline({ type: "peer-forget", peer: peer.id });
		} else if (matchesKey(data, "enter")) {
			const tip = this.data.grove.nodes.find((node) => node.refs.some((ref) => ref.kind === "tip" && ref.text === peer.id));
			if (tip) {
				this.state.selectedId = tip.id;
				this.state.tab = "commits";
			} else this.state.notice = `${peer.id} has no entries in this graph`;
		}
	}

	private runInline(action: ViewAction): void {
		void this.options
			.inline(action)
			.catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
			.then((notice) => {
				this.reload();
				this.state.notice = notice;
				this.options.requestRender();
			});
	}

	// ── rendering ────────────────────────────────────────────────────────────

	private height(): number {
		return Math.max(10, this.options.rows());
	}

	private listHeight(): number {
		// The tab bar, the top border, the bottom border, and the hint line.
		return this.height() - 4;
	}

	render(width: number): string[] {
		const total = Math.max(20, width);
		const bodyHeight = this.listHeight();
		const split = total >= 100;
		const leftWidth = split ? Math.floor(total * 0.58) : total;
		const rightWidth = total - leftWidth;

		// The help text has blank lines between its groups; a short terminal drops them.
		const help = this.helpLines();
		const content = !this.help
			? this.listLines(leftWidth - 4, bodyHeight)
			: help.length > bodyHeight
				? help.filter((line) => line !== "")
				: help;
		const lines = this.box(this.boxTitle(), content, leftWidth, bodyHeight, true);
		if (split) {
			const right = this.box(" Preview ", this.previewLines(rightWidth - 4, bodyHeight), rightWidth, bodyHeight, false);
			for (let index = 0; index < lines.length; index++) lines[index] += right[index] ?? "";
		}
		return [fit(this.tabBar(), total), ...lines, fit(this.hintLine(), total)];
	}

	private box(title: string, content: string[], width: number, height: number, active: boolean): string[] {
		const theme = this.theme;
		const border = (text: string) => theme.fg(active ? "borderAccent" : "borderMuted", text);
		const inner = Math.max(0, width - 2);
		const titleWidth = visibleWidth(title);
		const top = border("╭─") + title + border("─".repeat(Math.max(0, inner - titleWidth - 1)) + "╮");
		const lines = [fit(top, width)];
		for (let i = 0; i < height; i++) {
			lines.push(border("│") + " " + fit(content[i] ?? "", Math.max(0, inner - 2)) + " " + border("│"));
		}
		lines.push(border(`╰${"─".repeat(inner)}╯`));
		return lines;
	}

	/** The tabs, on their own line above the panel. The selected tab is drawn in reverse video. */
	private tabBar(): string {
		const theme = this.theme;
		const tabs = TABS.map((tab, index) => {
			const text = ` ${index + 1} ${TAB_TITLES[tab]} `;
			return tab === this.state.tab ? theme.bold(theme.fg("accent", `\x1b[7m${text}\x1b[27m`)) : theme.fg("muted", text);
		});
		return ` ${tabs.join(" ")}`;
	}

	/** Title of the panel: the tab name and what it currently shows. */
	private boxTitle(): string {
		const theme = this.theme;
		const tab = this.state.tab;
		const facts: string[] = [];
		if (this.help) facts.push("keys");
		else if (tab === "commits") {
			facts.push(this.state.filter);
			facts.push(this.state.related ? `${this.data.sessionCount} ${this.data.sessionCount === 1 ? "session" : "sessions"}` : "this session only");
		} else if (tab === "reflog") {
			facts.push(`${this.data.reflog.length} ${this.data.reflog.length === 1 ? "move" : "moves"}`);
		} else if (this.data.peers.available) {
			const alive = this.data.peers.peers.filter((peer) => peer.alive).length;
			facts.push(`mode ${this.data.peers.mode}`, `${alive}/${this.data.peers.maxPeers} alive`);
		}
		const detail = facts.map((fact) => theme.fg("borderMuted", " · ") + theme.fg("muted", fact)).join("");
		return ` ${theme.bold(TAB_TITLES[tab])}${detail} `;
	}

	private window(tab: Tab, height: number): { start: number; end: number } {
		const cursor = this.cursor(tab);
		let start = this.scroll[tab];
		if (cursor < start) start = cursor;
		if (cursor >= start + height) start = cursor - height + 1;
		start = Math.max(0, Math.min(start, Math.max(0, this.count(tab) - height)));
		this.scroll[tab] = start;
		return { start, end: Math.min(this.count(tab), start + height) };
	}

	private listLines(width: number, height: number): string[] {
		const tab = this.state.tab;
		if (tab === "peers" && !this.data.peers.available) {
			return [this.theme.fg("muted", "Peers need a git repository: each peer works in its own worktree.")];
		}
		if (this.count(tab) === 0) {
			const empty: Record<Tab, string> = {
				commits: "This session has no messages yet.",
				reflog: "No moves recorded yet. Jump somewhere in the tree and it shows up here.",
				peers: "No peers yet. Press n to start one.",
			};
			return [this.theme.fg("muted", empty[tab])];
		}
		const { start, end } = this.window(tab, height);
		const cursor = this.cursor(tab);
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const line = tab === "commits" ? this.commitLine(index) : tab === "reflog" ? this.reflogLine(index) : this.peerLine(index);
			lines.push(index === cursor ? this.selected(fit(line, width)) : line);
		}
		return lines;
	}

	/**
	 * Background for the selected row. A theme can leave `selectedBg` at the terminal default;
	 * the row would then look like any other, so a neutral gray is used instead.
	 */
	private selected(line: string): string {
		const themed = this.theme.bg("selectedBg", line);
		if (!themed.startsWith("\x1b[49m")) return themed;
		return `\x1b[48;5;${this.theme.appearance === "light" ? 253 : 238}m${line}\x1b[49m`;
	}

	private match(text: string): string {
		const themed = this.theme.bg("searchMatchBg", text);
		return themed.startsWith("\x1b[49m") ? `\x1b[7m${text}\x1b[27m` : themed;
	}

	private paint(segment: Segment, node: GroveNode): string {
		const theme = this.theme;
		switch (segment.tone) {
			case "id":
				return theme.fg(node.inCurrent ? "warning" : "dim", segment.text);
			case "author":
				return color(hash(segment.key ?? ""), segment.text);
			case "lane":
			case "node":
				return color(segment.lane ?? 0, segment.text);
			case "head":
				return theme.bold(theme.fg("success", segment.text));
			case "tip":
				return theme.bold(color(hash(segment.key ?? ""), segment.text));
			case "label":
				return theme.fg("accent", segment.text);
			case "subject":
				return this.highlight(segment.text, node);
			case "subjectDim":
				return theme.fg("muted", segment.text);
			case "folded":
				return theme.fg("dim", segment.text);
			case "space":
				return segment.text;
		}
	}

	private highlight(text: string, node: GroveNode): string {
		const query = this.state.search;
		if (!query || !this.matches(node)) return text;
		const at = text.toLowerCase().indexOf(query.toLowerCase());
		if (at === -1) return text;
		const end = at + query.length;
		return text.slice(0, at) + this.match(text.slice(at, end)) + text.slice(end);
	}

	private commitLine(index: number): string {
		const node = this.data.grove.nodes[index];
		const row = this.data.layout[index];
		if (!node || !row) return "";
		return renderRow(node, row)
			.map((segment) => this.paint(segment, node))
			.join("");
	}

	private reflogLine(index: number): string {
		const row = this.data.reflog[index];
		if (!row) return "";
		const theme = this.theme;
		const kind = row.entry.kind;
		const kindColor = kind === "summarize" ? "warning" : kind === "move" ? "accent" : "muted";
		const to = (row.entry.to ?? "(root)").slice(0, 8).padEnd(8);
		return [
			theme.fg("dim", `${ago(row.entry.time)} ago`.padStart(7)),
			theme.fg(kindColor, MOVE_LABELS[kind].padEnd(10)),
			theme.fg(row.reachable ? "warning" : "dim", to),
			row.reachable ? row.subject : theme.fg("dim", row.subject || "(gone)"),
		].join(" ");
	}

	private peerLine(index: number): string {
		const peer = this.data.peers.peers[index];
		if (!peer) return "";
		const theme = this.theme;
		const mark = !peer.alive ? theme.fg("dim", "○") : peer.status === "working" ? theme.fg("warning", "●") : theme.fg("success", "●");
		const name = theme.bold(color(hash(`peer:${peer.id}`), peer.id.padEnd(14)));
		const status = theme.fg(peer.alive ? "muted" : "dim", peer.status.padEnd(7));
		const self = peer.id === this.data.peers.self ? theme.fg("success", "(you) ") : "";
		const kind = peer.background ? theme.fg("dim", "bg ") : theme.fg("dim", "   ");
		return `${mark} ${name} ${status} ${kind}${theme.fg("accent", (peer.branch ?? "(detached)").padEnd(18))} ${self}${theme.fg("muted", peer.task ?? "")}`;
	}

	private previewLines(width: number, height: number): string[] {
		if (width <= 4) return [];
		const lines = this.state.tab === "peers" ? this.peerPreview() : this.entryPreview();
		const wrapped: string[] = [];
		for (const line of lines) {
			if (wrapped.length >= height) break;
			if (!line) wrapped.push("");
			else wrapped.push(...wrapTextWithAnsi(line, width));
		}
		return wrapped.slice(0, height);
	}

	private entryPreview(): string[] {
		const theme = this.theme;
		let node = this.selectedNode;
		if (this.state.tab === "reflog") {
			const target = this.data.reflog[this.state.reflogIndex]?.entry.to;
			const rowId = target ? (this.data.grove.byId.has(target) ? target : this.data.grove.rowOf.get(target)) : undefined;
			node = rowId ? this.data.grove.byId.get(rowId) : undefined;
		}
		if (!node) return [theme.fg("muted", "Nothing selected.")];
		const entry = node.entry;
		const message = (entry.message ?? {}) as Record<string, unknown>;
		const lines = [
			`${theme.fg("warning", node.id)} ${theme.fg("muted", node.kind)} ${theme.fg("dim", new Date(node.timestamp).toLocaleString())}`,
		];
		const facts: string[] = [];
		if (typeof message.model === "string") facts.push(message.model);
		if (node.folded > 0) facts.push(`${node.folded} folded ${node.folded === 1 ? "entry" : "entries"}`);
		if (!node.inCurrent) facts.push("other session (read-only)");
		if (node.mergeParents.length > 0) facts.push(`from ${node.mergeParents.map((id) => id.slice(0, 8)).join(", ")}`);
		if (facts.length > 0) lines.push(theme.fg("dim", facts.join(" · ")));
		lines.push("");

		const body =
			node.kind === "summary" || node.kind === "compaction"
				? String(entry.summary ?? "")
				: node.kind === "peer"
					? peerMessageBody(entry.content)
					: node.kind === "custom"
						? contentText(entry.content)
					: contentText(message.content ?? message.output);
		for (const line of body.split("\n").slice(0, 200)) lines.push(line.replace(/\t/g, "  "));
		if (Array.isArray(message.content)) {
			for (const block of message.content as { type?: unknown; name?: unknown; arguments?: unknown }[]) {
				if (block?.type !== "toolCall") continue;
				const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {});
				lines.push(theme.fg("accent", `→ ${String(block.name)} `) + theme.fg("dim", args.replace(/\s+/g, " ").slice(0, 300)));
			}
		}
		return lines;
	}

	private peerPreview(): string[] {
		const theme = this.theme;
		const peers = this.data.peers;
		if (!peers.available) return [];
		const lines: string[] = [];
		const peer = peers.peers[this.state.peerIndex];
		if (peer) {
			lines.push(theme.bold(color(hash(`peer:${peer.id}`), peer.id)));
			lines.push(`${theme.fg("muted", "worktree")} ${peer.cwd}`);
			if (peer.spawnedBy) lines.push(`${theme.fg("muted", "started by")} ${peer.spawnedBy}`);
			if (peer.task) lines.push(`${theme.fg("muted", "task")} ${peer.task}`);
			lines.push(theme.fg("dim", `pid ${peer.pid} · seen ${ago(peer.lastSeen)} ago`));
			lines.push("");
		}
		lines.push(theme.fg("accent", "Messages"));
		const messages = peers.messages.slice(-8);
		if (messages.length === 0) lines.push(theme.fg("dim", "none"));
		for (const message of messages) {
			lines.push(`${theme.fg("dim", ago(message.time).padStart(3))} ${message.from} → ${message.to}: ${message.text.split("\n")[0] ?? ""}`);
		}
		lines.push("", theme.fg("accent", "Board"));
		const notes = peers.notes.slice(-8);
		if (notes.length === 0) lines.push(theme.fg("dim", "empty"));
		for (const note of notes) lines.push(`${theme.fg("dim", ago(note.time).padStart(3))} ${note.from}: ${note.text.split("\n")[0] ?? ""}`);
		return lines;
	}

	private helpLines(): string[] {
		const theme = this.theme;
		const key = (keys: string, text: string) => `${theme.fg("accent", keys.padEnd(14))} ${text}`;
		return [
			theme.bold("Everywhere"),
			key("j/k ↑/↓", "move"),
			key("g/G", "first / last row"),
			key("ctrl+u/d", "page up / down"),
			key("tab 1 2 3", "switch tab"),
			key("r", "reload"),
			key("q esc", "close"),
			"",
			theme.bold("Tree"),
			key("enter", "jump to the entry (a user prompt goes back into the editor)"),
			key("s", "jump and summarize the branch you leave"),
			key("f", "fork a new session from the entry"),
			key("l", "set or clear a label"),
			key("p", "start a peer from the entry"),
			key("t", "cycle rows: turns → messages → all"),
			key("a", "show or hide related sessions and peers"),
			key("/ n N", "search, next match, previous match"),
			key("H", "select HEAD"),
			"",
			theme.bold("History"),
			key("enter", "go back to that position"),
			theme.fg("dim", "  \"left\" is where the conversation stood before a jump"),
			"",
			theme.bold("Peers"),
			key("n", "start a peer"),
			key("m", "send a message"),
			key("x", "stop a background peer"),
			key("d", "forget a peer that has exited"),
			key("o", "cycle mode: auto → manual → off"),
			key("enter", "show the peer in the graph"),
		];
	}

	private hintLine(): string {
		const theme = this.theme;
		if (this.searching) return `${theme.fg("accent", "/")}${this.state.search}${theme.fg("dim", "▏  enter: find · esc: cancel")}`;
		if (this.state.notice) return ` ${theme.fg("warning", this.state.notice)}`;
		const hint = (keys: string, text: string) => `${theme.fg("accent", keys)} ${theme.fg("muted", text)}`;
		const position = `${this.count(this.state.tab) === 0 ? 0 : this.cursor(this.state.tab) + 1}/${this.count(this.state.tab)}`;
		const parts: string[] = [theme.fg("dim", position)];
		if (this.state.tab === "commits") {
			parts.push(hint("enter", "jump"), hint("s", "summarize"), hint("f", "fork"), hint("l", "label"), hint("p", "peer"));
			parts.push(hint("t", "rows"), hint("a", "sessions"), hint("/", "search"));
		} else if (this.state.tab === "reflog") {
			parts.push(hint("enter", "go back there"));
		} else {
			parts.push(hint("n", "new"), hint("m", "message"), hint("x", "stop"), hint("d", "forget"), hint("o", "mode"));
		}
		parts.push(hint("?", "help"), hint("q", "close"));
		return ` ${parts.join(theme.fg("dim", "  "))}`;
	}
}
