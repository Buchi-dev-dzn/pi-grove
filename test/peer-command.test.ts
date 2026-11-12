import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import groveExtension from "../src/index.ts";
import { groveCompletions } from "../src/peers/commands.ts";
import { PeerModePicker } from "../src/ui/peer-mode-picker.ts";

const controller = vi.hoisted(() => ({
	grove: {} as object | undefined,
	config: vi.fn(() => ({ mode: "manual", maxPeers: 4 })),
	peers: vi.fn(() => []),
	setMode: vi.fn(),
	setDefaultMode: vi.fn(() => true),
}));
vi.mock("../src/peers/controller.ts", () => ({
	PeerController: class { constructor() { return controller; } },
}));
vi.mock("../src/peers/tools.ts", () => ({ registerPeerTools: vi.fn() }));

const ACTIVE = Symbol.for("pi-grove.active");
function clearActive() { Reflect.deleteProperty(globalThis, ACTIVE); }

function setup(mode = "tui") {
	const pi = {
		registerFlag: vi.fn(), registerMessageRenderer: vi.fn(), on: vi.fn(),
		registerCommand: vi.fn(), registerShortcut: vi.fn(),
	};
	groveExtension(pi as unknown as ExtensionAPI);
	const command = pi.registerCommand.mock.calls[0]![1] as {
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		getArgumentCompletions: typeof groveCompletions;
	};
	const ui = { custom: vi.fn(), notify: vi.fn() };
	const ctx = { mode, ui } as unknown as ExtensionCommandContext;
	return { command, ui, ctx };
}

beforeEach(() => {
	clearActive();
	vi.clearAllMocks();
	controller.grove = {};
	controller.setMode.mockResolvedValue(undefined);
});
afterEach(clearActive);

describe("/grove peers", () => {
	it("opens the inline picker without overlay options and applies its selection", async () => {
		const { command, ui, ctx } = setup();
		ui.custom.mockImplementation(async (factory) => {
			const done = vi.fn();
			const picker = factory({ requestRender: vi.fn() }, {}, {}, done);
			expect(picker).toBeInstanceOf(PeerModePicker);
			picker.handleInput("j");
			picker.handleInput("\r");
			return done.mock.calls[0]![0];
		});
		await command.handler("peers", ctx);
		expect(ui.custom.mock.calls[0]).toHaveLength(1);
		expect(controller.setMode).toHaveBeenCalledWith(ctx, "off");
		expect(controller.setDefaultMode).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith("peer mode for this repository: off", "info");
		expect(command.getArgumentCompletions).toBe(groveCompletions);
	});

	it("does not change configuration or notify on cancel", async () => {
		const { command, ui, ctx } = setup();
		ui.custom.mockResolvedValue(undefined);
		await command.handler("peers", ctx);
		expect(controller.setMode).not.toHaveBeenCalled();
		expect(controller.setDefaultMode).not.toHaveBeenCalled();
		expect(ui.notify).not.toHaveBeenCalled();
	});

	it("keeps explicit repository and global commands", async () => {
		const { command, ui, ctx } = setup();
		await command.handler("peers auto", ctx);
		expect(controller.setMode).toHaveBeenCalledWith(ctx, "auto");
		await command.handler("peers manual global", ctx);
		expect(controller.setDefaultMode).toHaveBeenCalledWith(ctx, "manual");
		expect(ui.custom).not.toHaveBeenCalled();
	});

	it("reports the mode without custom UI outside TUI", async () => {
		const { command, ui, ctx } = setup("rpc");
		await command.handler("peers", ctx);
		expect(ui.custom).not.toHaveBeenCalled();
		expect(controller.setMode).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("peer mode: manual"), "info");
	});

	it("does not open the picker outside a repository", async () => {
		controller.grove = undefined;
		const { command, ui, ctx } = setup();
		await command.handler("peers", ctx);
		expect(ui.custom).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledWith("peers need a git repository", "info");
	});

	it("reports a failed configuration write", async () => {
		const { command, ui, ctx } = setup();
		ui.custom.mockResolvedValue("auto");
		controller.setMode.mockRejectedValueOnce(new Error("write failed"));
		await command.handler("peers", ctx);
		expect(ui.notify).toHaveBeenCalledWith("write failed", "error");
	});
});
