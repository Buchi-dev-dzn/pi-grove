import type { GroveSource, RawEntry } from "../src/graph/model.ts";

let clock = Date.parse("2026-01-01T00:00:00.000Z");

export function resetClock(): void {
	clock = Date.parse("2026-01-01T00:00:00.000Z");
}

function stamp(): string {
	clock += 1000;
	return new Date(clock).toISOString();
}

export function user(id: string, parentId: string | null, text: string): RawEntry {
	return { type: "message", id, parentId, timestamp: stamp(), message: { role: "user", content: text } };
}

export function assistant(id: string, parentId: string | null, text: string, tools: string[] = []): RawEntry {
	const content: unknown[] = tools.map((name) => ({ type: "toolCall", id: `call-${id}-${name}`, name, arguments: {} }));
	if (text) content.push({ type: "text", text });
	return {
		type: "message",
		id,
		parentId,
		timestamp: stamp(),
		message: {
			role: "assistant",
			content,
			api: "test",
			provider: "test",
			model: "claude-test",
			stopReason: tools.length > 0 ? "toolUse" : "stop",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	};
}

export function toolResult(id: string, parentId: string | null, toolName: string, text: string): RawEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: stamp(),
		message: { role: "toolResult", toolName, content: [{ type: "text", text }] },
	};
}

export function summary(id: string, parentId: string | null, fromId: string, text: string): RawEntry {
	return { type: "branch_summary", id, parentId, timestamp: stamp(), fromId, summary: text };
}

export function label(id: string, parentId: string | null, targetId: string, text: string | undefined): RawEntry {
	return { type: "label", id, parentId, timestamp: stamp(), targetId, label: text };
}

export function peerMessage(id: string, parentId: string | null, from: string, fromEntryId: string, text: string): RawEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: stamp(),
		customType: "grove-message",
		content: `Message from peer "${from}":\n\n${text}`,
		display: true,
		details: { from, fromEntryId },
	};
}

export function source(
	sessionId: string,
	entries: RawEntry[],
	options: { leafId?: string | null; isCurrent?: boolean; name?: string; created?: number } = {},
): GroveSource {
	return {
		sessionId,
		name: options.name,
		created: options.created ?? 0,
		entries,
		leafId: options.leafId === undefined ? (entries[entries.length - 1]?.id ?? null) : options.leafId,
		isCurrent: options.isCurrent ?? true,
	};
}

/**
 * One session with two branches and a summary:
 *
 *   u1 ─ a1 ─ u2 ─ a2 ─ t2 ─ a2b          (abandoned branch)
 *          └─ s3 ─ u3 ─ a3                (current branch; s3 summarizes a2b)
 */
export function branchedSession(): RawEntry[] {
	return [
		user("u1", null, "plan the parser"),
		assistant("a1", "u1", "Here is a plan."),
		user("u2", "a1", "try recursive descent"),
		assistant("a2", "u2", "", ["bash", "read"]),
		toolResult("t2", "a2", "bash", "ok"),
		assistant("a2b", "t2", "Recursive descent works."),
		summary("s3", "a1", "a2b", "Tried recursive descent; it works."),
		user("u3", "s3", "now try a table-driven parser"),
		assistant("a3", "u3", "Table-driven parser done."),
	];
}
