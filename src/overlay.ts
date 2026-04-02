/**
 * Two-layer instruction generation for agents.
 *
 * Layer 1: Base agent definitions (agents/*.md) — reusable, checked in.
 * Layer 2: Per-task runtime instruction file — generated at spawn time.
 *
 * The overlay is written into the agent's worktree so Claude Code
 * picks it up automatically.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { SprintContract, GradingRubric } from "./types.js";
import { renderContractForOverlay } from "./contracts.js";
import { renderRubricForOverlay } from "./grading.js";
import {
  renderContextBundleMarkdown,
  type WorkerContextBundle,
} from "./context-builder.js";
import {
  renderAssignmentSpecMarkdown,
  renderProtocolContractMarkdown,
  type WorkerAssignmentSpec,
  type WorkerProtocolContract,
} from "./prompt-contract.js";

/**
 * Load a base agent definition from agents/<capability>.md.
 */
export function loadBaseDefinition(
  capability: string,
  agentsDir: string = "agents",
): string {
  const filePath = join(agentsDir, `${capability}.md`);
  if (!existsSync(filePath)) {
    return `# ${capability} agent\n\nNo base definition found.`;
  }
  return readFileSync(filePath, "utf-8");
}

/**
 * Generate the full runtime instruction content for an agent.
 */
export function generateOverlay(opts: {
  protocol: WorkerProtocolContract;
  assignment: WorkerAssignmentSpec;
  agentsDir?: string;
  contract?: SprintContract;
  rubric?: GradingRubric;
  handoffContext?: string;
  context?: WorkerContextBundle;
}): string {
  const base = loadBaseDefinition(opts.protocol.role, opts.agentsDir);

  const contractSection =
    opts.contract ? `\n${renderContractForOverlay(opts.contract)}\n` : "";

  const rubricSection =
    opts.rubric ? `\n${renderRubricForOverlay(opts.rubric)}\n` : "";

  const handoffSection =
    opts.handoffContext
      ? `\n## Previous Session Context\nThis is a context reset. A previous agent worked on this task. Here is their progress:\n\n${opts.handoffContext}\n`
      : "";
  const layeredContextSection =
    opts.context ? `\n${renderContextBundleMarkdown(opts.context)}\n` : "";

  return `# cnog Worker Contract

## Identity
- Agent: ${opts.protocol.agentName}
- Role: ${opts.protocol.role}
- Feature: ${opts.protocol.feature}
- Run: ${opts.protocol.runId}
${opts.protocol.branch ? `- Branch: ${opts.protocol.branch}` : ""}
${opts.protocol.executionTaskId ? `- Execution Task: ${opts.protocol.executionTaskId}` : ""}
${opts.protocol.issueId ? `- Issue: ${opts.protocol.issueId}` : ""}
${opts.protocol.reviewScopeId ? `- Review Scope: ${opts.protocol.reviewScopeId}` : ""}

${renderProtocolContractMarkdown(opts.protocol)}

${layeredContextSection}
${renderAssignmentSpecMarkdown(opts.assignment)}
${contractSection}
${rubricSection}
${handoffSection}
## Communication Commands
- Check messages: \`cnog mail check --agent ${opts.protocol.agentName}\`
- Send heartbeat: \`cnog heartbeat ${opts.protocol.agentName}\`
- Completion command: \`${opts.protocol.completionCommand}\`
- Escalation command: \`${opts.protocol.escalationCommand}\`
- Checkpoint command: \`${opts.protocol.checkpointCommand}\`

## Role Charter
${base}
`.trim() + "\n";
}

/**
 * Write the runtime instruction file into a worktree.
 */
export function writeOverlay(worktreePath: string, instructionFile: string, content: string): void {
  const overlayPath = join(worktreePath, instructionFile);
  const dir = dirname(overlayPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(overlayPath, content, "utf-8");
}
