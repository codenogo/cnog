/**
 * Claude Code runtime adapter.
 */

import { deployHooks } from "../hooks.js";
import type { AgentRuntime, RuntimeWorkspaceOpts, SpawnOpts } from "./types.js";

export class ClaudeRuntime implements AgentRuntime {
  readonly id = "claude";
  readonly name = "Claude Code";
  readonly instructionFile = "CLAUDE.md";

  buildCommand(_opts: SpawnOpts): string {
    return "claude --dangerously-skip-permissions";
  }

  prepareWorkspace(opts: RuntimeWorkspaceOpts): void {
    deployHooks({
      capability: opts.capability,
      agentName: opts.agentName,
      fileScope: opts.fileScope,
      worktreePath: opts.worktreePath,
    });
  }

  buildStallNudge(agentName: string): string {
    return `${agentName}: you appear stalled. Please send a heartbeat or report your status.`;
  }
}
