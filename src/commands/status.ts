import chalk from "chalk";

import { buildStatusSnapshot } from "../status.js";
import { withDb, buildContext } from "./context.js";

function formatDuration(durationMs: number | null | undefined): string {
  if (durationMs === undefined || durationMs === null) return "-";
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

export function statusCommand(opts: { json: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const snapshot = buildStatusSnapshot(ctx.db, ctx.config, ctx.watchdog);

    if (opts.json) {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }

    console.log(chalk.bold("cnog status"));
    console.log(`  Runtime: ${snapshot.summary.configuredRuntime}`);
    console.log(`  Active agents: ${snapshot.summary.activeAgents}`);
    console.log(`  Active tasks: ${snapshot.summary.activeTasks}`);
    console.log(`  Blocked tasks: ${snapshot.summary.blockedTasks}`);
    console.log(`  Failed tasks: ${snapshot.summary.failedTasks}`);
    console.log(`  Pending merges: ${snapshot.summary.pendingMerges}`);
    console.log(`  Merge conflicts: ${snapshot.summary.mergeConflicts}`);
    console.log(`  Unread mail: ${snapshot.summary.unreadMail}`);
    console.log(`  Tracked features: ${snapshot.summary.trackedFeatures}`);

    if (snapshot.agents.length > 0) {
      console.log("");
      console.log(chalk.bold("Agents"));
      for (const agent of snapshot.agents) {
        const health = agent.health === "healthy"
          ? ""
          : ` [${agent.health}${agent.healthReason ? `: ${agent.healthReason}` : ""}]`;
        const progress = ` tools=${agent.toolUseCount} tokens=${agent.inputTokens + agent.outputTokens} duration=${formatDuration(agent.durationMs)}`;
        const activity = agent.progressSummary
          ? ` activity=${agent.progressSummary}`
          : "";
        const transcript = agent.transcriptPath ? ` transcript=${agent.transcriptPath}` : "";
        const taskLog = agent.taskLogPath ? ` log=${agent.taskLogPath}` : "";
        const cost = agent.costUsd > 0 ? ` cost=$${agent.costUsd.toFixed(4)}` : "";
        console.log(`  ${agent.name} [${agent.runtime}/${agent.capability}] ${agent.state} — ${agent.feature ?? "-"}${health}${progress}${activity}${transcript}${taskLog}${cost}`);
      }
    }

    if (snapshot.tasks.length > 0) {
      console.log("");
      console.log(chalk.bold("Tasks"));
      for (const task of snapshot.tasks) {
        const subject = task.issueTitle ?? task.logicalName;
        const attempt = task.selectedSession
          ? ` [${task.selectedSession}${task.selectedAttempt ? `#${task.selectedAttempt}` : ""}; ${task.selectedReason}]`
          : "";
        const detail = task.lastError ?? task.summary;
        const suffix = detail ? ` — ${detail}` : "";
        const parent = task.parentTaskId ? ` parent=${task.parentTaskId}` : "";
        const output = task.outputPath ? ` log=${task.outputPath}` : "";
        const result = task.resultPath ? ` result=${task.resultPath}` : "";
        const transcript = task.transcriptPath ? ` ~ ${task.transcriptPath}` : "";
        console.log(`  ${subject} [${task.executor}/${task.capability}/${task.kind}] ${task.status} — ${task.feature}${attempt}${suffix}${parent}${output}${result}${transcript}`);
      }
    }

    if (snapshot.features.length > 0) {
      console.log("");
      console.log(chalk.bold("Features"));
      for (const feature of snapshot.features) {
        const verdict = feature.reviewVerdict ? ` (${feature.reviewVerdict})` : "";
        const profile = feature.profile ? ` [${feature.profile}]` : "";
        console.log(`  ${feature.feature}: ${feature.phase}${verdict}${profile}`);
      }
    }
  });
}
