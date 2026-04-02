/**
 * Git worktree management — the isolation plane.
 *
 * Each agent gets its own worktree and branch. Worktrees live in .cnog/worktrees/.
 * Branch naming: cnog/<feature>/<agent-name>
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { CnogError } from "./errors.js";
import { WORKTREE_BASE } from "./paths.js";

export { WORKTREE_BASE };

const VALID_RAW_SEGMENT = /^[a-z0-9._+-]+$/;
const SAFE_SEGMENT = /^[a-z0-9._+-]+$/;
const MAX_SEGMENT_LENGTH = 64;
const GIT_NO_PROMPT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_EDITOR: "true",
};

export interface WorktreeOptions {
  reuseExisting?: boolean;
  pruneBeforeCreate?: boolean;
  sparsePaths?: string[];
  symlinkDirectories?: string[];
}

export interface Worktree {
  path: string;
  branch: string;
  head: string;
  existed: boolean;
  featureSlug: string;
  agentSlug: string;
}

interface WorktreeSpec {
  path: string;
  branch: string;
  featureSlug: string;
  agentSlug: string;
}

interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

function hasPathTraversal(value: string): boolean {
  return value
    .split(/[\\/]+/)
    .some((segment) => segment === "." || segment === "..");
}

function validateRelativeSubpath(value: string, label: string): void {
  if (!value || value.trim().length === 0) {
    throw new Error(`Invalid ${label}: value must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`Invalid ${label}: NUL bytes are not allowed`);
  }
  if (isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value)) {
    throw new Error(`Invalid ${label}: absolute paths are not allowed`);
  }
  if (hasPathTraversal(value)) {
    throw new Error(`Invalid ${label}: path traversal is not allowed`);
  }
}

export function validateWorktreeSegment(value: string, label: string = "worktree name"): void {
  validateRelativeSubpath(value, label);
}

export function sanitizeWorktreeSegment(value: string, label: string = "worktree name"): string {
  validateWorktreeSegment(value, label);

  const normalized = value.normalize("NFKC").toLowerCase();
  let safe = normalized
    .replace(/[\\/]+/g, "+")
    .replace(/[^a-z0-9._+-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^[+-]+|[+-]+$/g, "")
    .replace(/-+/g, "-")
    .replace(/\++/g, "+");

  if (!safe || safe === "." || safe === "..") {
    safe = "worktree";
  }

  if (safe.endsWith(".lock")) {
    safe = `${safe.slice(0, -5)}-lock`;
  }

  // Preserve clean canonical names, but force a hash suffix when the original
  // input changes under normalization/lowercasing so distinct raw names do not
  // collapse onto the same worktree slug.
  const requiresHashSuffix = value !== normalized || safe !== normalized || !VALID_RAW_SEGMENT.test(normalized);
  if (safe.length > MAX_SEGMENT_LENGTH || requiresHashSuffix) {
    const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
    const maxBaseLength = MAX_SEGMENT_LENGTH - hash.length - 1;
    const base = safe
      .slice(0, maxBaseLength)
      .replace(/[+.-]+$/g, "") || "worktree";
    safe = `${base}-${hash}`;
  }

  if (!SAFE_SEGMENT.test(safe)) {
    throw new Error(`Invalid ${label}: could not derive a safe git worktree segment from "${value}"`);
  }

  return safe;
}

function normalizeOptions(options?: WorktreeOptions): Required<WorktreeOptions> {
  return {
    reuseExisting: options?.reuseExisting ?? true,
    pruneBeforeCreate: options?.pruneBeforeCreate ?? true,
    sparsePaths: options?.sparsePaths ?? [],
    symlinkDirectories: options?.symlinkDirectories ?? [],
  };
}

function resolveSpec(
  feature: string,
  agentName: string,
  projectRoot?: string,
): WorktreeSpec {
  const featureSlug = sanitizeWorktreeSegment(feature, "feature name");
  const agentSlug = sanitizeWorktreeSegment(agentName, "agent name");
  const branch = `cnog/${featureSlug}/${agentSlug}`;
  const base = projectRoot ?? process.cwd();
  return {
    featureSlug,
    agentSlug,
    branch,
    path: resolve(base, WORKTREE_BASE, agentSlug),
  };
}

function validateSparsePath(path: string): string {
  validateRelativeSubpath(path, "sparse checkout path");
  return path;
}

function symlinkDirectories(
  repoRoot: string,
  wtPath: string,
  directories: string[],
): void {
  for (const directory of directories) {
    try {
      validateRelativeSubpath(directory, "symlink directory");
      const sourcePath = resolve(repoRoot, directory);
      const destinationPath = resolve(wtPath, directory);
      if (!existsSync(sourcePath) || existsSync(destinationPath)) {
        continue;
      }
      mkdirSync(dirname(destinationPath), { recursive: true });
      symlinkSync(sourcePath, destinationPath, "dir");
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: string }).code)
        : "";
      if (code !== "EEXIST" && code !== "ENOENT") {
        throw err;
      }
    }
  }
}

function existingWorktreeFor(spec: WorktreeSpec, projectRoot?: string): Worktree | null {
  const existing = listWorktrees(projectRoot)
    .find((candidate) => resolve(candidate.path) === spec.path);
  if (!existing) {
    return null;
  }

  const expectedRef = `refs/heads/${spec.branch}`;
  if (existing.branch && existing.branch !== spec.branch && existing.branch !== expectedRef) {
    throw new Error(
      `Existing worktree at ${spec.path} is on ${existing.branch}, expected ${expectedRef}`,
    );
  }

  const headResult = _git({ cwd: spec.path }, "rev-parse", "HEAD");
  return {
    ...spec,
    head: headResult.status === 0 ? headResult.stdout.trim() : "unknown",
    existed: true,
  };
}

function teardownFailedCreate(
  feature: string,
  agentName: string,
  projectRoot?: string,
): void {
  remove(agentName, projectRoot, true);
  deleteBranch(feature, agentName, projectRoot, true);
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
    env: GIT_NO_PROMPT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
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
  return resolveSpec(feature, agentName).branch;
}

/**
 * Generate worktree path for an agent.
 */
export function worktreePath(
  agentName: string,
  projectRoot?: string,
): string {
  return resolveSpec("worktree", agentName, projectRoot).path;
}

/**
 * Create or resume a git worktree for an agent.
 *
 * Creates branch cnog/<feature>/<agent> from baseBranch
 * at .cnog/worktrees/<agent>/.
 */
export function create(
  agentName: string,
  feature: string,
  baseBranch: string = "main",
  projectRoot?: string,
  options?: WorktreeOptions,
): Worktree {
  const opts = normalizeOptions(options);
  const spec = resolveSpec(feature, agentName, projectRoot);

  if (opts.pruneBeforeCreate) {
    prune(projectRoot);
  }

  if (opts.reuseExisting) {
    const resumed = existingWorktreeFor(spec, projectRoot);
    if (resumed) {
      return resumed;
    }
  }

  if (existsSync(spec.path)) {
    throw new Error(`Failed to create worktree: path already exists but is not a registered git worktree (${spec.path})`);
  }

  const sparsePaths = opts.sparsePaths.map(validateSparsePath);
  const addArgs = ["worktree", "add"];
  if (sparsePaths.length > 0) {
    addArgs.push("--no-checkout");
  }
  addArgs.push("-B", spec.branch, spec.path, baseBranch);

  const result = _git(
    { cwd: projectRoot },
    ...addArgs,
  );

  if (result.status !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr.trim()}`);
  }

  try {
    if (sparsePaths.length > 0) {
      const sparse = _git(
        { cwd: spec.path },
        "sparse-checkout",
        "set",
        "--cone",
        "--",
        ...sparsePaths,
      );
      if (sparse.status !== 0) {
        throw new Error(`Failed to configure sparse-checkout: ${sparse.stderr.trim()}`);
      }
      const checkout = _git({ cwd: spec.path }, "checkout", "HEAD");
      if (checkout.status !== 0) {
        throw new Error(`Failed to checkout sparse worktree: ${checkout.stderr.trim()}`);
      }
    }

    if (opts.symlinkDirectories.length > 0) {
      symlinkDirectories(projectRoot ?? process.cwd(), spec.path, opts.symlinkDirectories);
    }
  } catch (err) {
    teardownFailedCreate(feature, agentName, projectRoot);
    if (err instanceof Error) {
      throw err;
    }
    throw new Error(String(err));
  }

  const headResult = _git({ cwd: spec.path }, "rev-parse", "HEAD");
  const head =
    headResult.status === 0 ? headResult.stdout.trim() : "unknown";

  return {
    ...spec,
    head,
    existed: false,
  };
}

/**
 * Merge prerequisite branches into an agent worktree before the agent starts.
 */
export function seedFromBranches(
  wtPath: string,
  branches: string[],
): void {
  for (const branch of branches) {
    const result = _git(
      { cwd: wtPath },
      "-c",
      "commit.gpgsign=false",
      "merge",
      "--no-ff",
      "--no-edit",
      branch,
    );

    if (result.status !== 0) {
      _git({ cwd: wtPath }, "merge", "--abort");
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
        worktrees.push({
          path,
          branch,
          head,
          existed: true,
          featureSlug: "",
          agentSlug: "",
        });
      }
      path = branch = head = "";
    }
  }

  if (path && branch) {
    worktrees.push({
      path,
      branch,
      head,
      existed: true,
      featureSlug: "",
      agentSlug: "",
    });
  }

  return worktrees;
}

/**
 * Clean up stale worktree references.
 */
export function prune(projectRoot?: string): void {
  _git({ cwd: projectRoot }, "worktree", "prune");
}
