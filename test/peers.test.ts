import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findRelatedSessions, loadSources, parseSession } from "../src/graph/sessions.ts";
import { Hub, isValidPeerName, type PeerRecord, readConfigFile, toPeerName, writeConfigFile } from "../src/peers/hub.ts";
import { grovePrompt } from "../src/peers/prompt.ts";
import { dialogReply, forkSession, pathTo, safeForkPoint } from "../src/peers/runtime.ts";
import { commitsAhead, createWorktree, type Exec, findRepo, removeWorktree } from "../src/peers/worktree.ts";
import { Reflog } from "../src/reflog/journal.ts";
import { assistant, branchedSession, resetClock, toolResult, user } from "./fixtures.ts";

function temp(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), `pi-grove-${prefix}-`)));
}

const exec: Exec = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd }, (error, stdout, stderr) => {
			resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});

function record(id: string, patch: Partial<PeerRecord> = {}): PeerRecord {
	return {
		id,
		pid: process.pid,
		cwd: "/repo",
		status: "idle",
		background: false,
		startedAt: 1,
		lastSeen: 1,
		...patch,
	};
}

beforeEach(resetClock);

describe("Hub", () => {
	it("registers peers and reports whether their process is alive", () => {
		const hub = new Hub(temp("hub"));
		hub.register(record("main"));
		hub.register(record("gone", { pid: 2 ** 30, startedAt: 0 }));
		const peers = hub.list();
		expect(peers.map((peer) => [peer.id, peer.alive, peer.status])).toEqual([
			["main", true, "idle"],
			["gone", false, "exited"],
		]);
	});

	it("delivers a message once and keeps it in the log", () => {
		const hub = new Hub(temp("hub"));
		hub.send({ from: "main", to: "api", text: "first", time: 1 });
		hub.send({ from: "ui", to: "api", text: "second", time: 2 });
		expect(hub.hasPending("api")).toBe(true);
		expect(hub.drain("api").map((message) => message.text)).toEqual(["first", "second"]);
		expect(hub.hasPending("api")).toBe(false);
		expect(hub.drain("api")).toEqual([]);
		expect(hub.messages().map((message) => `${message.from}>${message.to}`)).toEqual(["main>api", "ui>api"]);
	});

	it("keeps the board and the configuration", () => {
		const hub = new Hub(temp("hub"));
		expect(hub.getConfig()).toEqual({ mode: "auto", maxPeers: 4 });
		expect(hub.setConfig({ mode: "manual" })).toEqual({ mode: "manual", maxPeers: 4 });
		expect(hub.getConfig().mode).toBe("manual");
		hub.postNote("api", "api owns src/api");
		expect(hub.notes().map((note) => `${note.from}: ${note.text}`)).toEqual(["api: api owns src/api"]);
	});

	it("layers repository settings over the user's defaults", () => {
		const defaults = join(temp("user"), "nested", "config.json");
		const hub = new Hub(temp("hub"), defaults);
		expect(hub.getConfig()).toEqual({ mode: "auto", maxPeers: 4 });

		writeConfigFile(defaults, { mode: "manual", maxPeers: 2 });
		expect(hub.getConfig()).toEqual({ mode: "manual", maxPeers: 2 });
		expect(hub.overrides("mode")).toBe(false);

		// A repository setting changes only its own key; the other still follows the defaults.
		expect(hub.setConfig({ mode: "off" })).toEqual({ mode: "off", maxPeers: 2 });
		expect(hub.overrides("mode")).toBe(true);
		writeConfigFile(defaults, { maxPeers: 6 });
		expect(hub.getConfig()).toEqual({ mode: "off", maxPeers: 6 });
	});

	it("ignores invalid settings in a config file", () => {
		const file = join(temp("user"), "config.json");
		writeFileSync(file, JSON.stringify({ mode: "sometimes", maxPeers: 0, other: true }));
		expect(readConfigFile(file)).toEqual({});
		expect(readConfigFile(join(temp("user"), "missing.json"))).toEqual({});
	});

	it("finds a free name next to live peers of other processes", () => {
		const hub = new Hub(temp("hub"));
		// pid 1 always exists and is not this process.
		hub.register(record("main", { pid: 1 }));
		expect(hub.freeName("main")).toBe("main-2");
		expect(hub.freeName("Other Name")).toBe("other-name");
	});

	it("forgets only peers that are not running", () => {
		const hub = new Hub(temp("hub"));
		hub.register(record("main"));
		hub.register(record("gone", { pid: 2 ** 30 }));
		expect(hub.forget("main")).toBe(false);
		expect(hub.forget("gone")).toBe(true);
		expect(hub.list().map((peer) => peer.id)).toEqual(["main"]);
	});

	it("normalizes peer names", () => {
		expect(toPeerName("Try SQLite!")).toBe("try-sqlite");
		expect(toPeerName("///")).toBe("peer");
		expect(isValidPeerName("api-2")).toBe(true);
		expect(isValidPeerName("../x")).toBe(false);
	});
});

describe("Reflog", () => {
	it("records the position reached by chatting before a jump away from it", () => {
		const reflog = new Reflog(temp("reflog"));
		reflog.recordStart("s", "a1", "startup", 10);
		reflog.recordMove("s", "a3", "a1", false, 20);
		reflog.recordMove("s", "a1", "a3", true, 30);
		expect(reflog.read("s").map((entry) => `${entry.kind}:${entry.from}>${entry.to}`)).toEqual([
			"start:null>a1",
			"advance:a1>a3",
			"move:a3>a1",
			"summarize:a1>a3",
		]);
	});

	it("does not repeat the start position and keeps sessions apart", () => {
		const reflog = new Reflog(temp("reflog"));
		reflog.recordStart("s", "a1");
		reflog.recordStart("s", "a1");
		expect(reflog.read("s")).toHaveLength(1);
		expect(reflog.read("other")).toEqual([]);
	});
});

describe("forking a session", () => {
	it("cuts above an unfinished tool call", () => {
		const entries = [
			user("u1", null, "do it"),
			assistant("a1", "u1", "", ["bash"]),
			toolResult("t1", "a1", "bash", "ok"),
			assistant("a2", "t1", "", ["read"]),
		];
		expect(safeForkPoint(entries, "a2")).toBe("u1");
		expect(safeForkPoint(entries, "u1")).toBe("u1");
		expect(safeForkPoint(entries, "missing")).toBe(null);
		expect(safeForkPoint(entries, null)).toBe(null);
	});

	it("writes the path to the fork point with the original ids", () => {
		const entries = branchedSession();
		expect(pathTo(entries, "u3").map((entry) => entry.id)).toEqual(["u1", "a1", "s3", "u3"]);

		const directory = temp("sessions");
		const forked = forkSession({ entries, fromId: "u3", cwd: "/work/api", sessionDir: directory, parentSession: "/s/parent.jsonl" });
		const session = parseSession(readFileSync(forked.file, "utf8"));
		expect(session?.header).toMatchObject({ id: forked.sessionId, cwd: "/work/api", parentSession: "/s/parent.jsonl" });
		expect(session?.entries.map((entry) => entry.id)).toEqual(["u1", "a1", "s3", "u3"]);
		expect(session?.lastEntryId).toBe("u3");
	});

	it("starts a fresh session when there is no fork point", () => {
		const forked = forkSession({ entries: branchedSession(), fromId: null, cwd: "/work/api", sessionDir: temp("sessions") });
		expect(parseSession(readFileSync(forked.file, "utf8"))?.entries).toEqual([]);
	});

	it("cancels dialogs of a background peer and ignores other records", () => {
		const reply = dialogReply(JSON.stringify({ type: "extension_ui_request", id: "7", method: "confirm" }));
		expect(JSON.parse(reply ?? "{}")).toEqual({ type: "extension_ui_response", id: "7", cancelled: true });
		expect(dialogReply(JSON.stringify({ type: "extension_ui_request", id: "8", method: "notify" }))).toBeUndefined();
		expect(dialogReply(JSON.stringify({ type: "agent_start" }))).toBeUndefined();
		expect(dialogReply("not json")).toBeUndefined();
	});
});

describe("related sessions", () => {
	it("finds parents and forks through parentSession links", () => {
		const directory = temp("related");
		const write = (name: string, parent?: string) => {
			const file = join(directory, name);
			const header = { type: "session", version: 3, id: name, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo", parentSession: parent };
			writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(user(`${name}-u`, null, "hi"))}\n`);
			return file;
		};
		const root = write("root.jsonl");
		const current = write("current.jsonl", root);
		const child = write("child.jsonl", current);
		const grandchild = write("grandchild.jsonl", child);
		const sibling = write("sibling.jsonl", root);
		write("unrelated.jsonl");

		expect(findRelatedSessions(current, []).sort()).toEqual([child, grandchild, root, sibling].sort());

		const sources = loadSources(
			{ sessionId: "current.jsonl", sessionFile: current, created: 0, entries: [], leafId: null },
			[{ file: child, name: "api" }, { file: child }, { file: current }],
		);
		expect(sources.map((source) => [source.sessionId, source.name, source.isCurrent])).toEqual([
			["current.jsonl", undefined, true],
			["child.jsonl", "api", false],
		]);
	});
});

describe("worktrees", () => {
	async function repository(): Promise<string> {
		const root = temp("repo");
		await exec("git", ["init", "-q", "-b", "main"], { cwd: root });
		writeFileSync(join(root, "a.txt"), "a\n");
		await exec("git", ["add", "."], { cwd: root });
		await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], { cwd: root });
		return root;
	}

	it("creates a worktree on a grove branch and refuses to remove unsaved work", async () => {
		const root = await repository();
		const repo = await findRepo(exec, root);
		expect(repo).toMatchObject({ root, mainRoot: root, branch: "main", commonDir: join(root, ".git") });
		if (!repo) return;

		const created = await createWorktree(exec, repo, root, "api");
		expect(created).toMatchObject({ path: `${root}.grove/api`, branch: "grove/api", dirtySource: false });
		expect(existsSync(join(created.path, "a.txt"))).toBe(true);

		// The worktree shares the common directory, so it finds the same hub.
		const inside = await findRepo(exec, created.path);
		expect(inside).toMatchObject({ root: created.path, mainRoot: root, commonDir: repo.commonDir, branch: "grove/api" });

		await expect(createWorktree(exec, repo, root, "api")).rejects.toThrow(/already exists/);

		writeFileSync(join(created.path, "new.txt"), "work in progress\n");
		const refused = await removeWorktree(exec, root, created.path);
		expect(refused.removed).toBe(false);
		expect(existsSync(join(created.path, "new.txt"))).toBe(true);

		await exec("git", ["add", "."], { cwd: created.path });
		await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "work"], { cwd: created.path });
		expect(await commitsAhead(exec, root, "grove/api")).toBe(1);
		expect((await removeWorktree(exec, root, created.path)).removed).toBe(true);
		// The branch and its commit stay after the worktree is gone.
		expect(await commitsAhead(exec, root, "grove/api")).toBe(1);
	});

	it("reports uncommitted changes in the starting checkout and handles non-repositories", async () => {
		const root = await repository();
		writeFileSync(join(root, "a.txt"), "changed\n");
		const repo = await findRepo(exec, root);
		if (!repo) throw new Error("no repository");
		expect((await createWorktree(exec, repo, root, "ui")).dirtySource).toBe(true);
		expect(await findRepo(exec, temp("plain"))).toBeUndefined();
	});
});

describe("grovePrompt", () => {
	it("invites initiative only in auto mode", () => {
		const base = { self: "main", maxPeers: 4, cwd: "/repo", branch: "main" };
		expect(grovePrompt({ ...base, mode: "auto" })).toContain("on your own initiative");
		const manual = grovePrompt({ ...base, mode: "manual" });
		expect(manual).not.toContain("on your own initiative");
		expect(manual).toContain("only when the user asks");
	});

	it("tells a background peer where to work and whom to report to", () => {
		const prompt = grovePrompt({ self: "api", mode: "auto", maxPeers: 4, cwd: "/repo.grove/api", branch: "grove/api", spawnedBy: "main" });
		expect(prompt).toContain('You were started by peer "main"');
		expect(prompt).toContain("/repo.grove/api (branch grove/api)");
	});
});
