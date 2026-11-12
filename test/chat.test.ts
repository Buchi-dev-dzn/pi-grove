import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ClippedText, peerColor, shortPath } from "../src/ui/chat.ts";

describe("ClippedText", () => {
	const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");

	it("shows three wrapped rows with the hint on the last one", () => {
		const rows = new ClippedText(long, 2, false, "(expand)").render(40);
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => row.startsWith("  ") && visibleWidth(row) <= 40)).toBe(true);
		expect(stripTerminalSequences(rows[2] ?? "")).toMatch(/… \(expand\)$/);
	});

	it("shows everything when expanded or when the text is short", () => {
		expect(new ClippedText(long, 2, true, "(expand)").render(40).length).toBeGreaterThan(3);
		expect(new ClippedText("  short text\n", 2, false, "(expand)").render(40)).toEqual(["  short text"]);
	});

	it("counts rows after wrapping, also for a list of short lines", () => {
		const rows = new ClippedText("a\nb\nc\nd\ne", 0, false).render(40);
		expect(rows.map(stripTerminalSequences)).toEqual(["a", "b", "c…"]);
	});
});

describe("chat helpers", () => {
	it("shortens paths under the home directory", () => {
		expect(shortPath("/home/me/project.grove/api", "/home/me")).toBe("~/project.grove/api");
		expect(shortPath("/tmp/project", "/home/me")).toBe("/tmp/project");
		expect(shortPath("/home/me-too/x", "/home/me")).toBe("/home/me-too/x");
	});

	it("gives a peer the same color every time", () => {
		expect(peerColor("api")).toBe(peerColor("api"));
		expect(peerColor("api", "Ap")).toContain("Ap");
	});
});
