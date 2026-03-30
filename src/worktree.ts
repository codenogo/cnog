/**
 * Git worktree management — the isolation plane.
 *
 * Each agent gets its own worktree and branch. Worktrees live in .cnog/worktrees/.
 * Branch naming: cnog/<feature>/<agent-name>
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { CnogError } from "./errors.js";
import { WORKTREE_BASE } from "./paths.js";

export { WORKTREE_BASE };

export interface Worktree {
  path: string;
  branch: string;
  head: string;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a git command, optionally in a specific directory.
 */
export function _git(...args: string[]): GitResult;
export function _git(options: { cwd?: string }, ...args: string[]): GitResult;
export function _git(
  ...rawArgs: (string | { cwd?: string })[]
): GitResult {
  let cwd: string | undefined;
  let args: string[];

  if (typeof rawArgs[0] === "object" && rawArgs[0] !== null) {
    const options = rawArgs[0] as { cwd?: string };
    cwd = options.cwd;
    args = rawArgs.slice(1) as string[];
  } else {
    args = rawArgs as string[];
  }

  const result = spawnSync("git", args, {
    encoding: "utf-8",
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new CnogError("GIT_NOT_AVAILABLE");
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Generate branch name: cnog/<feature>/<agent-name>.
 */
export function branchName(feature: string, agentName: string): string {
  return `cnog/${feature}/${agentName}`;
}

/**
 * Generate worktree path for an agent.
 */
export function worktreePath(
  agentName: string,
  projectRoot?: string,
): string {
  const base = projectRoot ?? process.cwd();
  return resolve(base, WORKTREE_BASE, agentName);
}

/**
 * Create a git worktree for an agent.
 *
 * Creates branch cnog/<feature>/<agent> from baseBranch
 * at .cnog/worktrees/<agent>/.
 */
export function create(
  agentName: string,
  feature: string,
  baseBranch: string = "main",
  projectRoot?: string,
): Worktree {
  const wtPath = worktreePath(agentName, projectRoot);
  const branch = branchName(feature, agentName);

  const result = _git(
    { cwd: projectRoot },
    "worktree",
    "add",
    wtPath,
    "-b",
    branch,
    baseBranch,
  );

  if (result.status !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr.trim()}`);
  }

  // Get HEAD commit
  const headResult = _git({ cwd: wtPath }, "rev-parse", "HEAD");
  const head =
    headResult.status === 0 ? headResult.stdout.trim() : "unknown";

  return { path: wtPath, branch, head };
}

/**
 * Merge prerequisite branches into an agent worktree before the agent starts.
 */
export function seedFromBranches(
  worktreePath: string,
  branches: string[],
): void {
  for (const branch of branches) {
    const result = _git(
      { cwd: worktreePath },
      "merge",
      "--no-ff",
      "--no-edit",
      branch,
    );

    if (result.status !== 0) {
      _git({ cwd: worktreePath }, "merge", "--abort");
      throw new Error(`Failed to merge dependency branch ${branch}: ${result.stderr.trim()}`);
    }
  }
}

/**
 * Remove a worktree.
 */
export function remove(
  agentName: string,
  projectRoot?: string,
  force: boolean = false,
): boolean {
  const wtPath = worktreePath(agentName, projectRoot);

  const args = ["worktree", "remove", wtPath];
  if (force) {
    args.push("--force");
  }

  const result = _git({ cwd: projectRoot }, ...args);
  return result.status === 0;
}

/**
 * Delete the agent's branch from the main repo.
 */
export function deleteBranch(
  feature: string,
  agentName: string,
  projectRoot?: string,
  force: boolean = false,
): boolean {
  const branch = branchName(feature, agentName);
  const flag = force ? "-D" : "-d";
  const result = _git({ cwd: projectRoot }, "branch", flag, branch);
  return result.status === 0;
}

/**
 * List all git worktrees.
 */
export function listWorktrees(projectRoot?: string): Worktree[] {
  const result = _git(
    { cwd: projectRoot },
    "worktree",
    "list",
    "--porcelain",
  );

  if (result.status !== 0) {
    return [];
  }

  const worktrees: Worktree[] = [];
  let path = "";
  let branch = "";
  let head = "";

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice(9);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      branch = line.slice(7);
    } else if (line === "") {
      if (path && branch) {
        worktrees.push({ path, branch, head });
      }
      path = branch = head = "";
    }
  }

  // Capture last entry
  if (path && branch) {
    worktrees.push({ path, branch, head });
  }

  return worktrees;
}

/**
 * Clean up stale worktree references.
 */
export function prune(projectRoot?: string): void {
  _git({ cwd: projectRoot }, "worktree", "prune");
}
