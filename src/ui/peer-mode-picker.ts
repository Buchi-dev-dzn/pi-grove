import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MODE_DESCRIPTIONS } from "../peers/commands.ts";
import { PEER_MODES, type PeerMode } from "../peers/hub.ts";

/** Compact, non-overlay custom UI: pi temporarily replaces the prompt editor with this list. */
export class PeerModePicker implements Component {
	private index: number;

	constructor(
		private readonly current: PeerMode,
		private readonly theme: Theme,
		private readonly done: (mode: PeerMode | undefined) => void,
		private readonly requestRender: () => void,
	) {
		this.index = PEER_MODES.indexOf(current);
	}

	handleInput(data: string): void {
		if (data === "j" || matchesKey(data, "down")) this.index = Math.min(PEER_MODES.length - 1, this.index + 1);
		else if (data === "k" || matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
		else if (matchesKey(data, "enter")) return this.done(PEER_MODES[this.index]);
		else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
		else return;
		this.requestRender();
	}

	render(width: number): string[] {
		const { theme } = this;
		const lines = [
			theme.fg("accent", "How should agents use peers?"),
			theme.fg("muted", "Applies to this repository, shared by all its peers."),
			"",
		];
		for (const [index, mode] of PEER_MODES.entries()) {
			const selected = index === this.index;
			const label = `${selected ? "›" : " "} ${mode}${mode === this.current ? " (current)" : ""}`;
			lines.push(selected ? theme.fg("accent", theme.bold(label)) : label);
			for (const line of wrapTextWithAnsi(MODE_DESCRIPTIONS[mode], Math.max(1, width - 4))) {
				lines.push(theme.fg("muted", `    ${line}`));
			}
		}
		lines.push("", theme.fg("dim", "j/k or ↑/↓ to move · Enter to apply · Esc to cancel"));
		return lines.map((line) => truncateToWidth(line, Math.max(0, width)));
	}

	invalidate(): void {}
}
