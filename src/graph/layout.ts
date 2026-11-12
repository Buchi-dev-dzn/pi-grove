/**
 * Lane layout for the graph column, in the style of `git log --graph` and lazygit.
 *
 * Input rows are ordered newest first and every row comes before its parents. Each lane is a
 * vertical line waiting for one node. A row takes the leftmost lane waiting for it, the other
 * lanes waiting for it bend into it, and extra (merge) parents get a lane to the side.
 *
 * This module is pure and produces plain cells; colors are applied by the view.
 */

export interface LayoutRow {
	id: string;
	/** Parent ids. The first one continues this row's lane; the others are merge parents. */
	parents: string[];
}

export interface GraphCell {
	/** One glyph. `NODE` marks the node itself and is replaced by the view. */
	glyph: string;
	/** One filler character between this lane and the next: a space or a horizontal line. */
	fill: string;
	/** Lane index that decides the color of the glyph, or -1 for an empty cell. */
	glyphLane: number;
	/** Lane index that decides the color of the filler, or -1 for an empty filler. */
	fillLane: number;
}

export interface GraphRow {
	/** Lane of the node. */
	column: number;
	cells: GraphCell[];
}

export const NODE = "*";

function firstFree(lanes: (string | null)[], from = 0): number {
	for (let i = from; i < lanes.length; i++) if (lanes[i] === null) return i;
	return lanes.length;
}

function trim(lanes: (string | null)[]): void {
	while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
}

export function layoutGraph(rows: LayoutRow[]): GraphRow[] {
	const known = new Set(rows.map((row) => row.id));
	const lanes: (string | null)[] = [];
	const result: GraphRow[] = [];

	for (const row of rows) {
		const before = [...lanes];
		const incoming: number[] = [];
		for (let i = 0; i < before.length; i++) if (before[i] === row.id) incoming.push(i);

		const column = incoming[0] ?? firstFree(lanes);
		while (lanes.length <= column) lanes.push(null);
		for (const i of incoming) lanes[i] = null;

		const parents = [...new Set(row.parents)].filter((id) => known.has(id) && id !== row.id);
		const [primary, ...merges] = parents;
		lanes[column] = primary ?? null;

		// Lanes other than the node's own that connect to the node on this row.
		const endpoints = new Set<number>(incoming.slice(1));
		for (const merge of merges) {
			let lane = lanes.indexOf(merge);
			if (lane === column) continue;
			if (lane === -1) {
				lane = firstFree(lanes, column + 1);
				while (lanes.length <= lane) lanes.push(null);
				lanes[lane] = merge;
			}
			endpoints.add(lane);
		}

		const width = Math.max(before.length, lanes.length, column + 1);
		const low = Math.min(column, ...endpoints);
		const high = Math.max(column, ...endpoints);
		const cells: GraphCell[] = [];
		for (let i = 0; i < width; i++) {
			const up = i === column ? incoming.length > 0 : (before[i] ?? null) !== null;
			const down = (lanes[i] ?? null) !== null;
			let glyph = " ";
			let glyphLane = -1;
			if (i === column) {
				glyph = NODE;
				glyphLane = i;
			} else if (endpoints.has(i)) {
				const right = i > column;
				// An endpoint between the node and a farther endpoint also carries the horizontal line.
				const through = i > low && i < high;
				if (up && down) glyph = through ? "┼" : right ? "┤" : "├";
				else if (down) glyph = through ? "┬" : right ? "╮" : "╭";
				else glyph = through ? "┴" : right ? "╯" : "╰";
				glyphLane = i;
			} else if (up || down) {
				glyph = i > low && i < high ? "┼" : "│";
				glyphLane = i;
			} else if (i > low && i < high) {
				glyph = "─";
				glyphLane = nearestEndpoint(endpoints, column, i);
			}
			const horizontal = i >= low && i < high;
			cells.push({
				glyph,
				fill: horizontal ? "─" : " ",
				glyphLane,
				fillLane: horizontal ? nearestEndpoint(endpoints, column, i + 0.5) : -1,
			});
		}
		result.push({ column, cells });
		trim(lanes);
	}
	return result;
}

/** The endpoint a horizontal segment at `position` leads to: the next one away from the node. */
function nearestEndpoint(endpoints: Set<number>, column: number, position: number): number {
	let best = -1;
	for (const endpoint of endpoints) {
		if (position > column) {
			if (endpoint > position && (best === -1 || endpoint < best)) best = endpoint;
		} else if (endpoint < position && (best === -1 || endpoint > best)) best = endpoint;
	}
	return best === -1 ? column : best;
}

/** Plain text of one graph row, for tests and for non-color output. */
export function graphText(row: GraphRow, node = NODE): string {
	return row.cells
		.map((cell) => (cell.glyph === NODE ? node : cell.glyph) + cell.fill)
		.join("")
		.trimEnd();
}
