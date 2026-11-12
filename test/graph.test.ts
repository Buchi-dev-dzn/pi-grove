import { beforeEach, describe, expect, it } from "vitest";
import { graphText, layoutGraph } from "../src/graph/layout.ts";
import { buildGrove, type FilterMode, type GroveSource, initials } from "../src/graph/model.ts";
import { layoutNodes, plainText, renderRow } from "../src/graph/render.ts";
import { assistant, branchedSession, label, peerMessage, resetClock, source, user } from "./fixtures.ts";

function draw(sources: GroveSource[], filter: FilterMode = "turns"): string[] {
	const grove = buildGrove(sources, { filter });
	const layout = layoutNodes(grove.nodes);
	return grove.nodes.map((node, index) => plainText(renderRow(node, layout[index]!)));
}

beforeEach(resetClock);

describe("layoutGraph", () => {
	it("draws a straight line for a linear history", () => {
		const rows = layoutGraph([
			{ id: "c", parents: ["b"] },
			{ id: "b", parents: ["a"] },
			{ id: "a", parents: [] },
		]);
		expect(rows.map((row) => graphText(row))).toEqual(["*", "*", "*"]);
	});

	it("bends sibling branches into their shared parent", () => {
		const rows = layoutGraph([
			{ id: "c", parents: ["a"] },
			{ id: "b", parents: ["a"] },
			{ id: "a", parents: [] },
		]);
		expect(rows.map((row) => graphText(row))).toEqual(["*", "│ *", "*─╯"]);
	});

	it("opens a lane for a merge parent and closes it at that parent", () => {
		const rows = layoutGraph([
			{ id: "m", parents: ["b", "x"] },
			{ id: "b", parents: ["a"] },
			{ id: "x", parents: ["a"] },
			{ id: "a", parents: [] },
		]);
		expect(rows.map((row) => graphText(row))).toEqual(["*─╮", "* │", "│ *", "*─╯"]);
	});

	it("reuses a lane that is already waiting for the merge parent", () => {
		const rows = layoutGraph([
			{ id: "x2", parents: ["x"] },
			{ id: "m", parents: ["a", "x"] },
			{ id: "x", parents: ["a"] },
			{ id: "a", parents: [] },
		]);
		expect(rows.map((row) => graphText(row))).toEqual(["*", "├─*", "* │", "*─╯"]);
	});

	it("ignores parents that are not in the list", () => {
		const rows = layoutGraph([{ id: "a", parents: ["missing"] }]);
		expect(rows.map((row) => graphText(row))).toEqual(["*"]);
	});
});

describe("buildGrove", () => {
	it("shows one row per turn and folds the rest", () => {
		expect(draw([source("s", branchedSession())])).toEqual([
			"a3       Cl ◉ (HEAD) Table-driven parser done.",
			"u3       Us ● now try a table-driven parser",
			"s3       Su ●─╮ summary: Tried recursive descent; it works. +1",
			"a2b      Cl │ ○ Recursive descent works. +2",
			"u2       Us │ ○ try recursive descent +1",
			"u1       Us ●─╯ plan the parser",
		]);
	});

	it("shows every entry with the all filter", () => {
		const rows = draw([source("s", branchedSession())], "all");
		expect(rows).toHaveLength(9);
		expect(rows[4]).toBe("t2       To │ ○ bash: ok");
		expect(rows[5]).toBe("a2       Cl │ ○ → bash, read");
	});

	it("marks the active path and the head after navigating back", () => {
		const grove = buildGrove([source("s", branchedSession(), { leafId: "a2b" })]);
		const byId = grove.byId;
		expect(byId.get("a2b")?.isHead).toBe(true);
		expect(byId.get("u2")?.onActivePath).toBe(true);
		expect(byId.get("u3")?.onActivePath).toBe(false);
		expect(byId.get("u1")?.onActivePath).toBe(true);
	});

	it("keeps a head that the filter would hide and maps folded entries to their row", () => {
		const grove = buildGrove([source("s", branchedSession(), { leafId: "a2" })]);
		expect(grove.byId.get("a2")?.isHead).toBe(true);
		expect(grove.rowOf.get("t2")).toBe("a2b");
		expect(grove.rowOf.get("a1")).toBe("u2");
	});

	it("shows labels and does not treat a trailing label entry as a branch tip", () => {
		const entries = [...branchedSession(), label("l1", "a3", "a1", "plan")];
		const rows = draw([source("s", entries)]);
		expect(rows).toContain("a1       Cl ●─╯ [plan] Here is a plan.");
		expect(rows[0]).toBe("a3       Cl ◉ (HEAD) Table-driven parser done.");
	});

	it("removes a label that was cleared later", () => {
		const entries = [...branchedSession(), label("l1", "a3", "a1", "plan"), label("l2", "l1", "a1", undefined)];
		expect(draw([source("s", entries)]).some((row) => row.includes("[plan]"))).toBe(false);
	});

	it("merges peer sessions into one graph with message edges", () => {
		const base = [user("u1", null, "build the app"), assistant("a1", "u1", "Splitting into api and ui.")];
		const api = [...base, user("p1", "a1", "task: build api"), assistant("p1a", "p1", "api done")];
		const ui = [...base, user("q1", "a1", "task: build ui"), assistant("q1a", "q1", "ui done")];
		const main = [
			...base,
			user("u2", "a1", "meanwhile write docs"),
			assistant("a2", "u2", "docs written"),
			peerMessage("m1", "a2", "api", "p1a", "api is done on grove/api"),
			assistant("a3", "m1", "noted"),
			peerMessage("m2", "a3", "ui", "q1a", "ui is done"),
			assistant("a4", "m2", "merging both"),
		];
		const sources = [
			source("main", main, { created: 1 }),
			source("api", api, { isCurrent: false, name: "api", created: 2 }),
			source("ui", ui, { isCurrent: false, name: "ui", created: 3 }),
		];
		expect(draw(sources)).toEqual([
			"a4       Cl ◉ (HEAD) merging both",
			"m2       Ui ●─╮ ui is done +1",
			"m1       Ap ●─┼─╮ api is done on grove/api +1",
			"u2       Us ● │ │ meanwhile write docs +1",
			"q1a      Ui │ ○ │ (ui) ui done",
			"q1       Us │ ○ │ task: build ui +1",
			"p1a      Ap │ │ ○ (api) api done",
			"p1       Us │ │ ○ task: build api +1",
			"u1       Us ●─┴─╯ build the app",
		]);
		const grove = buildGrove(sources);
		expect(grove.byId.get("p1a")?.inCurrent).toBe(false);
		expect(grove.byId.get("p1a")?.ownerSession).toBe("api");
		expect(grove.byId.get("u1")?.ownerSession).toBe("main");
	});

	it("orders children before parents even when timestamps disagree", () => {
		const entries = [user("u1", null, "first"), assistant("a1", "u1", "reply"), user("u2", "a1", "second")];
		entries[0]!.timestamp = "2027-01-01T00:00:00.000Z";
		const grove = buildGrove([source("s", entries)]);
		expect(grove.nodes.map((node) => node.id)).toEqual(["u2", "u1"]);
	});

	it("drops Markdown markers from the subject", () => {
		const entries = [user("u1", null, "## Plan\n\ndetails"), assistant("a1", "u1", "**Result:** done with `x`")];
		const grove = buildGrove([source("s", entries)], { filter: "messages" });
		expect(grove.nodes.map((node) => node.subject)).toEqual(["Result: done with `x`", "Plan"]);
	});

	it("returns nothing for an empty session", () => {
		expect(buildGrove([source("s", [])]).nodes).toEqual([]);
	});
});

describe("initials", () => {
	it("makes a two-letter tag", () => {
		expect(initials("api")).toBe("Ap");
		expect(initials("claude-opus")).toBe("Cl");
		expect(initials("x")).toBe("Xx");
		expect(initials("")).toBe("??");
	});
});
