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
export const PID_FILE = join(CNOG_DIR, "orchestrator.pid");

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
