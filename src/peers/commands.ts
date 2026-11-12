import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { PEER_MODES, type PeerMode } from "./hub.ts";

export const MODE_DESCRIPTIONS: Record<PeerMode, string> = {
	auto: "Agents can start peers on their own when work benefits from parallel help.",
	manual: "Keep peer tools available, but start peers only when you ask.",
	off: "Hide peer tools and leave the grove. The graph and history still work.",
};

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "peers", label: "peers", description: "Choose a peer mode, or set it with peers [auto|manual|off] [global]" },
	{ value: "spawn", label: "spawn", description: "spawn <name> <task>: start a peer in its own worktree" },
	{ value: "send", label: "send", description: "send <peer|all> <message>" },
	{ value: "stop", label: "stop", description: "stop <peer>: stop a background peer" },
];

/** Completion values replace the entire argument string, not just its last word. */
export function groveCompletions(prefix: string): AutocompleteItem[] | null {
	const input = prefix.trimStart();
	let items = SUBCOMMANDS;
	if (/^peers\s+/.test(input)) {
		const args = input.split(/\s+/);
		if (args.length === 2) {
			items = PEER_MODES.map((mode) => ({ value: `peers ${mode}`, label: mode, description: MODE_DESCRIPTIONS[mode] }));
		} else if (args.length === 3 && PEER_MODES.includes(args[1] as PeerMode)) {
			items = [{ value: `peers ${args[1]} global`, label: "global", description: "Set the default for all repositories; keep repository overrides" }];
		} else return null;
	}
	const normalized = input.replace(/\s+/g, " ");
	const matches = items.filter((item) => item.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}
