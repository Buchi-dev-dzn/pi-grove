/**
 * Prints the graph for a session file without starting pi.
 *
 *   npm run demo -- ~/.pi/agent/sessions/<dir>/<session>.jsonl [turns|messages|all]
 *
 * Related sessions (forks and their parents) in the same directory are included.
 */

import { buildGrove, FILTER_MODES, type FilterMode } from "../src/graph/model.ts";
import { layoutNodes, plainText, renderRow } from "../src/graph/render.ts";
import { findRelatedSessions, loadSources, readSession } from "../src/graph/sessions.ts";

const [file, mode] = process.argv.slice(2);
if (!file) {
	console.error("usage: npm run demo -- <session.jsonl> [turns|messages|all]");
	process.exit(1);
}
const filter: FilterMode = FILTER_MODES.includes(mode as FilterMode) ? (mode as FilterMode) : "turns";

const session = readSession(file);
if (!session) {
	console.error(`not a pi session file: ${file}`);
	process.exit(1);
}

const sources = loadSources(
	{
		sessionId: session.header.id,
		sessionFile: file,
		created: Date.parse(session.header.timestamp) || 0,
		name: session.name,
		entries: session.entries,
		leafId: session.lastEntryId,
	},
	findRelatedSessions(file, []).map((related) => ({ file: related })),
);
const grove = buildGrove(sources, { filter });
const layout = layoutNodes(grove.nodes);

const width = process.stdout.columns ?? 100;
grove.nodes.forEach((node, index) => {
	const row = layout[index];
	if (row) console.log(plainText(renderRow(node, row)).slice(0, width));
});
