import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { buildGrove } from "../src/graph/model.ts";
import { groveCompletions } from "../src/peers/commands.ts";
import type { PeerMode } from "../src/peers/hub.ts";
import { GroveView, initialState } from "../src/ui/grove-view.ts";
import { PeerModePicker } from "../src/ui/peer-mode-picker.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function picker(current: PeerMode = "manual") {
	const done = vi.fn();
	const render = vi.fn();
	return { view: new PeerModePicker(current, theme, done, render), done, render };
}

describe("peer mode picker", () => {
	it("shows English explanations, repository scope, current mode and keyboard hints", () => {
		const { view } = picker();
		const output = view.render(100).map(stripTerminalSequences).join("\n");
		expect(output).toContain("How should agents use peers?");
		expect(output).toContain("Applies to this repository");
		expect(output).toContain("› manual (current)");
		expect(output).toContain("start peers only when you ask");
		expect(output).toContain("j/k or ↑/↓");
		expect(output).toContain("Enter to apply");
		expect(output).toContain("Esc to cancel");
	});

	it("starts on the current mode without changing it until Enter", () => {
		const { view, done } = picker("off");
		view.render(80);
		expect(done).not.toHaveBeenCalled();
		view.handleInput("\r");
		expect(done).toHaveBeenCalledWith("off");
	});

	it.each([
		["j", "off"], ["\u001b[B", "off"],
		["k", "auto"], ["\u001b[A", "auto"],
	] as const)("moves with %j and confirms %s", (key, expected) => {
		const { view, done, render } = picker();
		view.handleInput(key);
		expect(done).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledOnce();
		view.handleInput("\r");
		expect(done).toHaveBeenCalledWith(expected);
	});

	it("clamps movement at the ends of the list", () => {
		const { view, done } = picker("auto");
		view.handleInput("k");
		view.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith("auto");
		for (let i = 0; i < 5; i++) view.handleInput("j");
		view.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith("off");
	});

	it.each(["\u001b", "\u0003"])("cancels with %j without applying a mode", (key) => {
		const { view, done } = picker();
		view.handleInput("j");
		view.handleInput(key);
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("ignores unrelated typing and renders safely at narrow widths", () => {
		const { view, done, render } = picker();
		view.handleInput("x");
		expect(done).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
		for (const width of [1, 10, 30, 80]) {
			expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});

describe("Peers tab mode action", () => {
	it("closes the graph to open the picker instead of silently cycling the mode", () => {
		const state = initialState();
		state.tab = "peers";
		const done = vi.fn();
		const inline = vi.fn();
		const view = new GroveView({
			state, theme, done, inline, rows: () => 24, requestRender: vi.fn(),
			load: () => ({
				grove: buildGrove([]), layout: [], reflog: [], sessionCount: 0,
				peers: { available: true, mode: "manual", maxPeers: 4, peers: [], messages: [], notes: [] },
			}),
		});
		view.handleInput("o");
		expect(done).toHaveBeenCalledWith({ type: "peer-mode" });
		expect(inline).not.toHaveBeenCalled();
	});
});

describe("grove command completions", () => {
	it("keeps subcommand completion", () => {
		expect(groveCompletions("")?.map((item) => item.value)).toEqual(["peers", "spawn", "send", "stop"]);
		expect(groveCompletions("pe")?.map((item) => item.value)).toEqual(["peers"]);
	});

	it("completes peer modes with descriptions and full argument values", () => {
		const items = groveCompletions("peers ");
		expect(items?.map((item) => item.value)).toEqual(["peers auto", "peers manual", "peers off"]);
		expect(items?.every((item) => Boolean(item.description))).toBe(true);
		expect(groveCompletions("peers m")?.map((item) => item.value)).toEqual(["peers manual"]);
		expect(groveCompletions("  peers   a")?.[0]?.value).toBe("peers auto");
	});

	it.each(["auto", "manual", "off"])("completes global after %s", (mode) => {
		for (const suffix of ["", "g", "global"]) {
			expect(groveCompletions(`peers ${mode} ${suffix}`)?.[0]?.value).toBe(`peers ${mode} global`);
		}
	});

	it.each(["unknown", "peers unknown", "peers unknown ", "peers auto nope", "peers auto global ", "spawn ", "send ", "stop "])("does not suggest invalid arguments for %j", (prefix) => {
		expect(groveCompletions(prefix)).toBeNull();
	});
});
