/**
 * Configuration loader.
 *
 * Reads .cnog/config.yaml with sensible defaults.
 * Supports .cnog/config.local.yaml for machine-specific overrides (gitignored).
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { PID_FILE as PID_FILE_PATH, CNOG_DIR, DEFAULTS, findProjectRoot } from "./paths.js";

export interface CnogConfig {
  project: {
    name: string;
    root: string;
    canonicalBranch: string;
  };
  agents: {
    runtime: string;
    maxConcurrent: number;
    maxDepth: number;
    staggerDelayMs: number;
    bootDelayMs: number;
  };
  orchestrator: {
    tickIntervalMs: number;
    maxWip: number;
  };
  watchdog: {
    staleThresholdMs: number;
    zombieThresholdMs: number;
  };
  verify: {
    commands: string[];
  };
}

const DEFAULT_CONFIG: CnogConfig = {
  project: {
    name: "",
    root: ".",
    canonicalBranch: "main",
  },
  agents: {
    runtime: "claude",
    maxConcurrent: 4,
    maxDepth: 2,
    staggerDelayMs: 2000,
    bootDelayMs: 2000,
  },
  orchestrator: {
    tickIntervalMs: 10_000,
    maxWip: 4,
  },
  watchdog: {
    staleThresholdMs: 15 * 60 * 1000,
    zombieThresholdMs: 60 * 60 * 1000,
  },
  verify: {
    commands: [],
  },
};

/**
 * Deep merge two objects (source overrides target).
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const val = source[key];
    if (
      val !== null &&
      val !== undefined &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>,
      );
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Load config from .cnog/config.yaml + optional .cnog/config.local.yaml.
 */
export function loadConfig(projectRoot: string = findProjectRoot()): CnogConfig {
  let config: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;

  const configPath = join(projectRoot, CNOG_DIR, "config.yaml");
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown> | null;
    if (parsed) {
      config = deepMerge(config, parsed);
    }
  }

  // Local overrides (gitignored)
  const localPath = join(projectRoot, CNOG_DIR, "config.local.yaml");
  if (existsSync(localPath)) {
    const raw = readFileSync(localPath, "utf-8");
    const parsed = YAML.parse(raw) as Record<string, unknown> | null;
    if (parsed) {
      config = deepMerge(config, parsed);
    }
  }

  return config as unknown as CnogConfig;
}

/**
 * Write default config to .cnog/config.yaml.
 */
export function writeDefaultConfig(projectRoot: string = findProjectRoot()): string {
  const configPath = join(projectRoot, CNOG_DIR, "config.yaml");
  const content = YAML.stringify(DEFAULT_CONFIG);
  writeFileSync(configPath, content, "utf-8");
  return configPath;
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

// PID file path imported from paths.ts

/**
 * Write the orchestrator PID file.
 */
export function writePidFile(projectRoot: string = findProjectRoot()): void {
  const path = join(projectRoot, PID_FILE_PATH);
  writeFileSync(path, String(process.pid), "utf-8");
}

/**
 * Read the orchestrator PID file.
 */
export function readPidFile(projectRoot: string = findProjectRoot()): number | null {
  const path = join(projectRoot, PID_FILE_PATH);
  if (!existsSync(path)) return null;
  const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

/**
 * Remove the orchestrator PID file.
 */
export function removePidFile(projectRoot: string = findProjectRoot()): void {
  const path = join(projectRoot, PID_FILE_PATH);
  if (existsSync(path)) {
    rmSync(path);
  }
}

/**
 * Check if the orchestrator is already running.
 */
export function isOrchestratorRunning(projectRoot: string = findProjectRoot()): boolean {
  const pid = readPidFile(projectRoot);
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // Stale PID file
    removePidFile(projectRoot);
    return false;
  }
}
