/**
 * Git worktrees for peers. Each peer works on its own branch `grove/<name>` in its own
 * worktree, so peers never edit the same checkout.
 *
 * Nothing here deletes work: worktrees are removed without `--force`, so git refuses when there
 * are uncommitted changes, and branches are never deleted.
 */

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/** Compatible with `pi.exec`. */
export type Exec = (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

export interface RepoInfo {
	/** Root of the worktree that contains `cwd`. */
	root: string;
	/** The `.git` directory shared by all worktrees. */
	commonDir: string;
	/** Root of the main worktree. */
	mainRoot: string;
	/** Current branch, or undefined when HEAD is detached. */
	branch?: string;
}

export const BRANCH_PREFIX = "grove/";

async function git(exec: Exec, cwd: string, args: string[]): Promise<ExecResult> {
	try {
		return await exec("git", args, { cwd, timeout: 30_000 });
	} catch (error) {
		return { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1 };
	}
}

export async function findRepo(exec: Exec, cwd: string): Promise<RepoInfo | undefined> {
	const result = await git(exec, cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]);
	if (result.code !== 0) return undefined;
	const [root, commonDir] = result.stdout.trim().split("\n");
	if (!root || !commonDir) return undefined;
	const head = await git(exec, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const branch = head.code === 0 ? head.stdout.trim() || undefined : undefined;
	// In a normal repository the common directory is `<main worktree>/.git`.
	const mainRoot = basename(commonDir) === ".git" ? dirname(commonDir) : root;
	return { root, commonDir, mainRoot, branch };
}

/** Where a peer's worktree goes: next to the repository, in `<repo>.grove/<name>`. */
export function worktreePath(repo: RepoInfo, name: string): string {
	return join(dirname(repo.mainRoot), `${basename(repo.mainRoot)}.grove`, name);
}

export interface CreatedWorktree {
	path: string;
	branch: string;
	/** True when the starting checkout had uncommitted changes, which the new worktree lacks. */
	dirtySource: boolean;
}

/** Creates the branch `grove/<name>` at the current HEAD and checks it out in a new worktree. */
export async function createWorktree(exec: Exec, repo: RepoInfo, cwd: string, name: string): Promise<CreatedWorktree> {
	const path = worktreePath(repo, name);
	const branch = `${BRANCH_PREFIX}${name}`;
	if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
	const exists = await git(exec, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
	if (exists.code === 0) throw new Error(`branch ${branch} already exists; choose another peer name`);
	const status = await git(exec, cwd, ["status", "--porcelain"]);
	const added = await git(exec, cwd, ["worktree", "add", "-b", branch, path, "HEAD"]);
	if (added.code !== 0) throw new Error(`git worktree add failed: ${added.stderr.trim() || added.stdout.trim()}`);
	return { path, branch, dirtySource: status.code === 0 && status.stdout.trim().length > 0 };
}

/**
 * Removes a peer's worktree and keeps its branch. Git refuses when the worktree has
 * uncommitted changes; that refusal is reported, never overridden.
 */
export async function removeWorktree(exec: Exec, cwd: string, path: string): Promise<{ removed: boolean; reason?: string }> {
	if (!existsSync(path)) return { removed: true };
	const result = await git(exec, cwd, ["worktree", "remove", path]);
	if (result.code === 0) return { removed: true };
	return { removed: false, reason: result.stderr.trim() || result.stdout.trim() };
}

/** Number of commits on `branch` that the checkout in `cwd` does not have. */
export async function commitsAhead(exec: Exec, cwd: string, branch: string): Promise<number | undefined> {
	const result = await git(exec, cwd, ["rev-list", "--count", `HEAD..${branch}`]);
	if (result.code !== 0) return undefined;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isNaN(count) ? undefined : count;
}
