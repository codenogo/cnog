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
  agentName: string;
  capability: string;
  feature: string;
  branch?: string;
  taskId?: string;
  taskPrompt: string;
  runId?: string;
  fileScope?: string[];
  verifyCommands?: string[];
  agentsDir?: string;
  contract?: SprintContract;
  rubric?: GradingRubric;
  handoffContext?: string;
  completionCommand?: string;
}): string {
  const base = loadBaseDefinition(opts.capability, opts.agentsDir);

  const fileScopeSection =
    opts.fileScope && opts.fileScope.length > 0
      ? `## File Scope\n${opts.fileScope.map((f) => `- ${f}`).join("\n")}`
      : "";

  const verifySection =
    opts.verifyCommands && opts.verifyCommands.length > 0
      ? `## Verify Commands\n${opts.verifyCommands.map((c) => `- \`${c}\``).join("\n")}`
      : "";

  const contractSection =
    opts.contract ? `\n${renderContractForOverlay(opts.contract)}\n` : "";

  const rubricSection =
    opts.rubric ? `\n${renderRubricForOverlay(opts.rubric)}\n` : "";

  const handoffSection =
    opts.handoffContext
      ? `\n## Previous Session Context\nThis is a context reset. A previous agent worked on this task. Here is their progress:\n\n${opts.handoffContext}\n`
      : "";

  const completionCommand = opts.completionCommand ?? (opts.capability === "evaluator"
    ? `cnog mail send orchestrator "evaluate: <VERDICT>" --from ${opts.agentName} --type result --payload '{"scores":[{"criterion":"functionality","score":0.0,"feedback":"..."}]}'`
    : `cnog mail send orchestrator "done" --from ${opts.agentName} --type worker_done${opts.branch ? ` --payload '{"feature":"${opts.feature}","branch":"${opts.branch}"}'` : ""}`);

  return `# Task: ${opts.taskId ?? "unassigned"}

## Your Identity
- Agent: ${opts.agentName}
- Capability: ${opts.capability}
- Feature: ${opts.feature}
- Branch: ${opts.branch ?? "unassigned"}
${opts.runId ? `- Run: ${opts.runId}` : ""}

## Task
${opts.taskPrompt}

${fileScopeSection}

${verifySection}
${contractSection}
${rubricSection}
${handoffSection}
## Communication
- Report completion: \`${completionCommand}\`
- Report errors: \`cnog mail send orchestrator "blocked on X" --from ${opts.agentName} --type escalation\`
- Check messages: \`cnog mail check --agent ${opts.agentName}\`
- Send heartbeat: \`cnog heartbeat ${opts.agentName}\`
- Save checkpoint: \`cnog checkpoint save --agent ${opts.agentName} --summary "what you did" --pending "what remains"\`

## Base Instructions
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
