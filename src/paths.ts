/**
 * Centralized path constants and directory structure.
 *
 * Single source of truth for all cnog filesystem locations.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Root directories
// ---------------------------------------------------------------------------

export const CNOG_DIR = ".cnog";
export const AGENTS_DEF_DIR = "agents";

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export const DB_PATH = join(CNOG_DIR, "cnog.db");

// ---------------------------------------------------------------------------
// Subdirectories under .cnog/
// ---------------------------------------------------------------------------

export const WORKTREE_BASE = join(CNOG_DIR, "worktrees");
export const CHECKPOINT_DIR = join(CNOG_DIR, "agents");
export const CONTRACTS_DIR = join(CNOG_DIR, "contracts");
export const REVIEWS_DIR = join(CNOG_DIR, "reviews");
export const SCRATCH_DIR = join(CNOG_DIR, "scratch");
export const PID_FILE = join(CNOG_DIR, "orchestrator.pid");
export const LOG_FILE = join(CNOG_DIR, "orchestrator.log");

// ---------------------------------------------------------------------------
// Artifact paths (run-scoped)
// ---------------------------------------------------------------------------

export const FEATURES_ARTIFACT_DIR = join(CNOG_DIR, "features");

export function runArtifactDir(feature: string, runId: string, projectRoot: string = "."): string {
  return resolve(projectRoot, FEATURES_ARTIFACT_DIR, feature, "runs", runId);
}

export function artifactPath(feature: string, runId: string, filename: string, projectRoot: string = "."): string {
  return join(runArtifactDir(feature, runId, projectRoot), filename);
}

export function runArchiveDir(feature: string, runId: string, projectRoot: string = "."): string {
  return join(runArtifactDir(feature, runId, projectRoot), "archive");
}

export function runSessionDir(feature: string, runId: string, projectRoot: string = "."): string {
  return join(runArtifactDir(feature, runId, projectRoot), "sessions");
}

export function runTaskDir(feature: string, runId: string, projectRoot: string = "."): string {
  return join(runArtifactDir(feature, runId, projectRoot), "tasks");
}

export function runScratchDir(feature: string, runId: string, projectRoot: string = "."): string {
  return resolve(projectRoot, SCRATCH_DIR, "runs", runId);
}

export function runScratchSharedDir(feature: string, runId: string, projectRoot: string = "."): string {
  return join(runScratchDir(feature, runId, projectRoot), "shared");
}

export function runScratchRoleDir(
  feature: string,
  runId: string,
  role: string,
  projectRoot: string = ".",
): string {
  return join(runScratchDir(feature, runId, projectRoot), role);
}

export function runScratchAgentDir(
  feature: string,
  runId: string,
  role: string,
  agentName: string,
  projectRoot: string = ".",
): string {
  return join(runScratchRoleDir(feature, runId, role, projectRoot), agentName);
}

export function sessionTranscriptRelativePath(feature: string, runId: string, agentName: string): string {
  return join(FEATURES_ARTIFACT_DIR, feature, "runs", runId, "sessions", `${agentName}.log`);
}

export function sessionTranscriptPath(
  feature: string,
  runId: string,
  agentName: string,
  projectRoot: string = ".",
): string {
  return join(runSessionDir(feature, runId, projectRoot), `${agentName}.log`);
}

export function executionTaskOutputRelativePath(feature: string, runId: string, taskId: string): string {
  return join(FEATURES_ARTIFACT_DIR, feature, "runs", runId, "tasks", `${taskId}.output`);
}

export function executionTaskOutputPath(
  feature: string,
  runId: string,
  taskId: string,
  projectRoot: string = ".",
): string {
  return join(runTaskDir(feature, runId, projectRoot), `${taskId}.output`);
}

// ---------------------------------------------------------------------------
// Planning paths
// ---------------------------------------------------------------------------

export const FEATURES_DIR = join("docs", "planning", "work", "features");

export function featureDir(feature: string, projectRoot: string = "."): string {
  return resolve(projectRoot, FEATURES_DIR, feature);
}

/**
 * Find the nearest ancestor that owns the shared .cnog directory.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = resolve(start);

  while (true) {
    if (existsSync(join(dir, CNOG_DIR))) {
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(start);
    }

    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

export const TMUX_SOCKET = "cnog";
export const SESSION_PREFIX = "cnog-";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const PLAN_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Defaults (overridable via config)
// ---------------------------------------------------------------------------

export const DEFAULTS = {
  bootDelayMs: 2000,
  tickIntervalMs: 10_000,
  maxWip: 4,
  staleThresholdMs: 15 * 60 * 1000,
  zombieThresholdMs: 60 * 60 * 1000,
  dashboardRefreshMs: 2000,
  canonicalBranch: "main",
} as const;
