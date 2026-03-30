/**
 * Agent runtime interface.
 *
 * Abstracts how agents are spawned so cnog can support multiple
 * coding agent runtimes (Claude Code, Pi, Aider, etc).
 */

import type { Capability } from "../types.js";

export interface SpawnOpts {
  sessionName: string;
  workingDir: string;
  agentName: string;
}

export interface RuntimeWorkspaceOpts {
  worktreePath: string;
  agentName: string;
  capability: Capability;
  fileScope?: string[];
}

export interface AgentRuntime {
  /** Runtime identifier. */
  readonly id: string;

  /** Display name. */
  readonly name: string;

  /** Filename for agent instructions (e.g., "CLAUDE.md"). */
  readonly instructionFile: string;

  /** Build the shell command to launch this runtime. */
  buildCommand(opts: SpawnOpts): string;

  /** Prepare runtime-specific state inside the worktree before launch. */
  prepareWorkspace?(opts: RuntimeWorkspaceOpts): void;

  /** Runtime-specific nudge text for a stalled agent. */
  buildStallNudge?(agentName: string): string;
}
