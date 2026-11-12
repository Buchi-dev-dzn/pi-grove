/**
 * Turns a graph node and its lane layout into styled segments:
 *
 *   a1b2c3d4 Us ● │ refactor the parser (HEAD) [checkpoint]
 *   ──id──── au ─graph─ ──subject──────────────────────────
 *
 * Segments carry a tone instead of a color so this module stays free of terminal and theme code.
 */

import { type GraphRow, layoutGraph, NODE } from "./layout.ts";
import type { GroveNode } from "./model.ts";

export type Tone =
	| "id"
	| "author"
	| "lane"
	| "node"
	| "space"
	| "head"
	| "tip"
	| "label"
	| "subject"
	| "subjectDim"
	| "folded";

export interface Segment {
	text: string;
	tone: Tone;
	/** Lane index for `lane` and `node` tones. */
	lane?: number;
	/** Color key for the `author` and `tip` tones. */
	key?: string;
}

export const GLYPH_HEAD = "◉";
export const GLYPH_ACTIVE = "●";
export const GLYPH_OTHER = "○";

export function nodeGlyph(node: GroveNode): string {
	if (node.isHead) return GLYPH_HEAD;
	return node.onActivePath ? GLYPH_ACTIVE : GLYPH_OTHER;
}

/** Lane layout for a list of nodes as returned by `buildGrove`. */
export function layoutNodes(nodes: GroveNode[]): GraphRow[] {
	return layoutGraph(
		nodes.map((node) => ({ id: node.id, parents: node.parentId ? [node.parentId, ...node.mergeParents] : node.mergeParents })),
	);
}

export interface RenderOptions {
	/** Lanes beyond this count are cut off and marked with an ellipsis. */
	maxLanes?: number;
}

export function renderRow(node: GroveNode, graph: GraphRow, options: RenderOptions = {}): Segment[] {
	const maxLanes = options.maxLanes ?? 12;
	const segments: Segment[] = [
		{ text: node.id.slice(0, 8).padEnd(8), tone: "id" },
		{ text: " ", tone: "space" },
		{ text: node.author.padEnd(2), tone: "author", key: node.authorKey },
		{ text: " ", tone: "space" },
	];

	const cells = graph.cells.slice(0, maxLanes);
	for (const cell of cells) {
		if (cell.glyph === NODE) segments.push({ text: nodeGlyph(node), tone: "node", lane: cell.glyphLane });
		else if (cell.glyphLane >= 0) segments.push({ text: cell.glyph, tone: "lane", lane: cell.glyphLane });
		else segments.push({ text: cell.glyph, tone: "space" });
		if (cell.fillLane >= 0) segments.push({ text: cell.fill, tone: "lane", lane: cell.fillLane });
		else segments.push({ text: cell.fill, tone: "space" });
	}
	if (graph.cells.length > maxLanes) segments.push({ text: "… ", tone: "folded" });

	for (const ref of node.refs) {
		if (ref.kind === "head") segments.push({ text: "(HEAD) ", tone: "head" });
		else if (ref.kind === "tip") segments.push({ text: `(${ref.text}) `, tone: "tip", key: `peer:${ref.text}` });
		else segments.push({ text: `[${ref.text}] `, tone: "label" });
	}
	segments.push({ text: node.subject, tone: node.inCurrent ? "subject" : "subjectDim" });
	if (node.folded > 0) segments.push({ text: ` +${node.folded}`, tone: "folded" });
	return segments;
}

export function plainText(segments: Segment[]): string {
	return segments
		.map((segment) => segment.text)
		.join("")
		.trimEnd();
}
