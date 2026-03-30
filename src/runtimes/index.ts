/**
 * Runtime registry.
 *
 * Lookup runtimes by ID. Default is Claude Code.
 * New runtimes can be registered at startup from config.
 */

import type { AgentRuntime } from "./types.js";
import { ClaudeRuntime } from "./claude.js";

export type { AgentRuntime, SpawnOpts } from "./types.js";

const REGISTRY = new Map<string, AgentRuntime>();

// Register built-in runtimes
REGISTRY.set("claude", new ClaudeRuntime());

/**
 * Get a runtime by ID.
 */
export function getRuntime(id: string = "claude"): AgentRuntime {
  const runtime = REGISTRY.get(id);
  if (!runtime) {
    throw new Error(`Unknown runtime '${id}'. Registered runtimes: ${listRuntimes().join(", ") || "none"}`);
  }
  return runtime;
}

/**
 * Register a custom runtime.
 */
export function registerRuntime(runtime: AgentRuntime): void {
  REGISTRY.set(runtime.id, runtime);
}

/**
 * List all registered runtime IDs.
 */
export function listRuntimes(): string[] {
  return [...REGISTRY.keys()];
}

export function hasRuntime(id: string): boolean {
  return REGISTRY.has(id);
}
