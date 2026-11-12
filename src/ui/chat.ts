/**
 * How peer activity looks in the conversation. Starting a peer, sending a message and
 * receiving one are drawn the same way, as one exchange:
 *
 *   + strings  new peer
 *     Implement src/strings.js with tests. Own only those two files.
 *     ✓ grove/strings · ~/project.grove/strings
 *
 *   → strings
 *     Math is done. Keep the string helpers free of dependencies.
 *
 *   ← strings
 *     Ready on grove/strings. All 3 tests pass.
 *
 * The functions here build plain components and have no access to the session.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Lane and peer colors: 256-color indexes that read well on dark and light backgrounds.
const PALETTE = [39, 208, 170, 77, 203, 75, 178, 141, 37, 209];

export function paletteColor(index: number, text: string): string {
	const code = PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
	return `\x1b[38;5;${code}m${text}\x1b[39m`;
}

export function hash(text: string): number {
	let value = 0;
	for (let i = 0; i < text.length; i++) value = (value * 31 + text.charCodeAt(i)) | 0;
	return Math.abs(value);
}

/** A peer's name in its own color, the same one the graph uses for it. */
export function peerColor(name: string, text = name): string {
	return paletteColor(hash(`peer:${name}`), text);
}

export const GLYPH_SPAWN = "+";
export const GLYPH_SENT = "→";
export const GLYPH_RECEIVED = "←";
export const GLYPH_BOARD = "▪";
export const GLYPH_PEERS = "◇";

const COLLAPSED_ROWS = 3;

/**
 * Text that shows only its first rows until expanded. Rows are counted after wrapping to the
 * terminal width, so a long paragraph and a list of short lines take the same space.
 */
export class ClippedText implements Component {
	private readonly text: string;
	private readonly padding: number;
	private readonly expanded: boolean;
	private readonly hint: string;

	/** `hint` is appended to the last row when rows are hidden, for example "(ctrl+o to expand)". */
	constructor(text: string, padding: number, expanded: boolean, hint = "") {
		this.text = text.trim();
		this.padding = padding;
		this.expanded = expanded;
		this.hint = hint;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = Math.max(10, width - this.padding * 2);
		let rows = wrapTextWithAnsi(this.text, inner);
		if (!this.expanded && rows.length > COLLAPSED_ROWS) {
			rows = rows.slice(0, COLLAPSED_ROWS);
			const room = Math.max(1, inner - visibleWidth(this.hint) - (this.hint ? 1 : 0));
			const last = truncateToWidth(`${rows[COLLAPSED_ROWS - 1] ?? ""}…`, room, "…");
			rows[COLLAPSED_ROWS - 1] = this.hint ? `${last} ${this.hint}` : last;
		}
		const indent = " ".repeat(this.padding);
		return rows.map((row) => indent + row);
	}
}

export interface ExchangeOptions {
	glyph: string;
	/** Peer name, or a fixed word such as "board". */
	name: string;
	/** False for names that are not peers; they are drawn in the accent color. */
	isPeer?: boolean;
	/** Short text after the name, such as "new peer". */
	note?: string;
	body?: string;
	expanded: boolean;
	/** Text such as "ctrl+o to expand", shown when the body is clipped. */
	expandHint?: string;
	outputPad: number;
}

/** A header line with an indented body. */
export function exchange(theme: Theme, options: ExchangeOptions): Component {
	const container = new Container();
	const name = options.isPeer === false ? theme.fg("accent", options.name) : peerColor(options.name);
	let header = `${theme.fg("muted", options.glyph)} ${theme.bold(name)}`;
	if (options.note) header += `  ${theme.fg("dim", options.note)}`;
	container.addChild(new Text(header, options.outputPad, 0));
	if (options.body?.trim()) {
		const hint = options.expandHint ? theme.fg("dim", `(${options.expandHint})`) : "";
		container.addChild(new ClippedText(options.body, options.outputPad + 2, options.expanded, hint));
	}
	return container;
}

export type StatusKind = "ok" | "warning" | "error" | "plain";

/** One indented line under an exchange: the outcome of the action. */
export function statusLine(theme: Theme, kind: StatusKind, text: string, outputPad: number): Component {
	const mark =
		kind === "ok"
			? theme.fg("success", "✓ ")
			: kind === "warning"
				? theme.fg("warning", "! ")
				: kind === "error"
					? theme.fg("error", "✗ ")
					: "";
	const color = kind === "error" ? "error" : kind === "warning" ? "warning" : "dim";
	return new Text(mark + theme.fg(color, text), outputPad + 2, 0);
}

export function empty(): Component {
	return new Container();
}

/** Shortens a path under the home directory to `~/...`. */
export function shortPath(path: string, home = process.env.HOME ?? ""): string {
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
