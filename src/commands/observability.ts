import chalk from "chalk";

import { openDb, withDb, buildContext } from "./context.js";
import { runDashboard } from "../dashboard.js";
import { projectFileSize } from "../file-tail.js";
import {
  loadCheckpoint,
  loadHandoffs,
  loadProgressArtifact,
  type CheckpointSelector,
} from "../checkpoint.js";
import { getRubric } from "../grading.js";
import { loadConfig, resolveConfigProjectRoot } from "../config.js";
import { findProjectRoot } from "../paths.js";
import type { SessionActivityKind } from "../types.js";

function classifyActivity(toolName?: string): SessionActivityKind {
  switch ((toolName ?? "").toLowerCase()) {
    case "read":
      return "read";
    case "write":
    case "edit":
    case "multiedit":
      return "write";
    case "grep":
    case "glob":
      return "search";
    case "bash":
      return "bash";
    default:
      return "other";
  }
}

function summarizeActivity(toolName?: string, target?: string): string {
  const tool = toolName?.trim();
  const normalizedTarget = target?.trim();
  if (!tool) {
    return normalizedTarget ? `Activity on ${normalizedTarget}` : "Activity recorded";
  }

  switch (tool.toLowerCase()) {
    case "read":
      return normalizedTarget ? `Read ${normalizedTarget}` : "Read files";
    case "write":
    case "edit":
    case "multiedit":
      return normalizedTarget ? `Modified ${normalizedTarget}` : "Modified files";
    case "grep":
      return normalizedTarget ? `Searched ${normalizedTarget}` : "Searched code";
    case "glob":
      return normalizedTarget ? `Listed ${normalizedTarget}` : "Listed files";
    case "bash":
      return normalizedTarget ? `Ran shell command for ${normalizedTarget}` : "Ran shell command";
    default:
      return normalizedTarget ? `${tool} ${normalizedTarget}` : `Used ${tool}`;
  }
}

function resolveCheckpointSelector(
  db: ReturnType<typeof openDb>,
  agent: string,
): CheckpointSelector | null {
  const session = db.sessions.get(agent) ?? db.sessions.getLatestByLogicalName(agent);
  if (!session?.feature) {
    return null;
  }
  return {
    runId: session.run_id,
    feature: session.feature,
    logicalName: session.logical_name,
  };
}

export function dashboardCommand(): void {
  withDb((db) => runDashboard(db));
}

export function feedCommand(opts: { agent?: string; source?: string; follow: boolean }): void {
  const db = openDb();
  const events = db.events.query({ agent: opts.agent, source: opts.source, limit: 20 });

  for (const e of events.reverse()) {
    const time = e.timestamp.slice(11, 19);
    console.log(`${chalk.gray(time)} [${e.level}] ${e.source}: ${e.message}`);
  }

  if (opts.follow) {
    console.log(chalk.gray("\nFollowing... (Ctrl+C to stop)"));
    let lastId = events.length > 0 ? events[events.length - 1].id : 0;
    const timer = setInterval(() => {
      const newer = db.events.query({ limit: 10 });
      for (const e of newer.reverse()) {
        if (e.id > lastId) {
          const time = e.timestamp.slice(11, 19);
          console.log(`${chalk.gray(time)} [${e.level}] ${e.source}: ${e.message}`);
          lastId = e.id;
        }
      }
    }, 2000);
    process.on("SIGINT", () => { clearInterval(timer); db.close(); process.exit(0); });
  } else {
    db.close();
  }
}

export function logsCommand(opts: { agent?: string; level?: string; since?: string; limit: number; json: boolean }): void {
  withDb((db) => {
    const events = db.events.query(opts);
    if (opts.json) { console.log(JSON.stringify(events, null, 2)); return; }
    for (const e of events) console.log(`${e.timestamp} [${e.level}] ${e.source}: ${e.message}`);
  });
}

export function costsCommand(opts: { json: boolean }): void {
  withDb((db) => {
    const costs = db.metrics.summary();
    if (opts.json) { console.log(JSON.stringify(costs)); return; }
    console.log(chalk.bold("Cost Summary"));
    console.log(`  Input tokens: ${costs.total_input.toLocaleString()}`);
    console.log(`  Output tokens: ${costs.total_output.toLocaleString()}`);
    console.log(`  Total cost: $${costs.total_cost.toFixed(4)}`);
  });
}

export function checkpointSaveCommand(agent: string, summary: string, pending: string, files: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    ctx.agents.checkpoint(agent, {
      progressSummary: summary,
      pendingWork: pending,
      filesModified: files ? files.split(",").filter(Boolean) : [],
    });
    console.log(chalk.green(`Checkpoint saved for ${agent}`));
  });
}

export function checkpointShowCommand(agent: string, opts: { json: boolean }): void {
  withDb((db) => {
    const selector = resolveCheckpointSelector(db, agent);
    if (!selector) { console.log(chalk.gray("No checkpoint found.")); return; }
    const checkpoint = loadCheckpoint(db, selector);
    if (!checkpoint) { console.log(chalk.gray("No checkpoint found.")); return; }
    if (opts.json) { console.log(JSON.stringify(checkpoint, null, 2)); return; }
    console.log(chalk.bold(`Checkpoint: ${checkpoint.logicalName}`));
    console.log(`  Run: ${checkpoint.runId}`);
    console.log(`  Task: ${checkpoint.taskId}`);
    console.log(`  Branch: ${checkpoint.currentBranch}`);
    console.log(`  Summary: ${checkpoint.progressSummary}`);
    if (checkpoint.pendingWork) console.log(`  Pending: ${checkpoint.pendingWork}`);
    if (checkpoint.filesModified.length > 0) console.log(`  Files: ${checkpoint.filesModified.join(", ")}`);
    console.log(`  Transcript: ${checkpoint.resumeContext.transcriptPath ?? "-"}`);
    console.log(`  Task log: ${checkpoint.resumeContext.taskLogPath ?? "-"}`);
    console.log(`  Last activity: ${checkpoint.resumeContext.lastActivitySummary ?? "-"}`);
    console.log(`  Tool uses: ${checkpoint.resumeContext.toolUseCount}`);
  });
}

export function progressCommand(agent: string): void {
  withDb((db) => {
    const selector = resolveCheckpointSelector(db, agent);
    const progress = selector ? loadProgressArtifact(db, selector) : null;
    console.log(progress ?? chalk.gray("No progress artifact found."));
  });
}

export function runtimeProgressUpdateCommand(opts: {
  agent: string;
  tool?: string;
  target?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  quiet?: boolean;
}): void {
  withDb((db) => {
    const discoveredRoot = findProjectRoot();
    const config = loadConfig(discoveredRoot);
    const projectRoot = resolveConfigProjectRoot(discoveredRoot, config);
    const session = db.sessions.get(opts.agent);
    if (!session) {
      throw new Error(`Agent ${opts.agent} not found.`);
    }

    db.sessions.heartbeat(opts.agent);

    const transcriptSize = projectFileSize(session.transcript_path, projectRoot);
    const activityKind = classifyActivity(opts.tool);
    const summary = summarizeActivity(opts.tool, opts.target);

    db.sessionProgress.recordActivity({
      sessionId: session.id,
      runId: session.run_id,
      executionTaskId: session.execution_task_id,
      transcriptPath: session.transcript_path,
      transcriptSize,
      toolName: opts.tool ?? null,
      activityKind,
      summary,
      target: opts.target ?? null,
    });

    if ((opts.inputTokens ?? 0) > 0 || (opts.outputTokens ?? 0) > 0 || (opts.costUsd ?? 0) > 0) {
      db.metrics.record({
        agent_name: session.name,
        feature: session.feature ?? "",
        run_id: session.run_id,
        input_tokens: opts.inputTokens ?? 0,
        output_tokens: opts.outputTokens ?? 0,
        cost_usd: opts.costUsd ?? 0,
      });
      const existing = db.sessionProgress.get(session.id);
      db.sessionProgress.update(session.id, {
        input_tokens: (existing?.input_tokens ?? 0) + (opts.inputTokens ?? 0),
        output_tokens: (existing?.output_tokens ?? 0) + (opts.outputTokens ?? 0),
        cost_usd: (existing?.cost_usd ?? 0) + (opts.costUsd ?? 0),
      });
    }

    if (!opts.quiet) {
      console.log(chalk.green(`Progress updated for ${opts.agent}: ${summary}`));
    }
  });
}

export function runtimeProgressShowCommand(agent: string, opts: { json: boolean }): void {
  withDb((db) => {
    const session = db.sessions.get(agent) ?? db.sessions.getLatestByLogicalName(agent);
    if (!session) {
      console.log(chalk.gray("No session found."));
      return;
    }
    const progress = db.sessionProgress.get(session.id);
    if (!progress) {
      console.log(chalk.gray("No runtime progress recorded."));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({
        ...progress,
        recentActivities: JSON.parse(progress.recent_activities_json),
      }, null, 2));
      return;
    }
    console.log(chalk.bold(`Runtime Progress: ${session.name}`));
    console.log(`  Tool uses: ${progress.tool_use_count}`);
    console.log(`  Tokens: in=${progress.input_tokens} out=${progress.output_tokens}`);
    console.log(`  Cost: $${progress.cost_usd.toFixed(4)}`);
    console.log(`  Last activity: ${progress.last_activity_summary ?? "-"}`);
    console.log(`  Last activity at: ${progress.last_activity_at ?? "-"}`);
    console.log(`  Transcript: ${progress.transcript_path ?? "-"}`);
    console.log(`  Transcript size: ${progress.transcript_size}`);
    if (session.execution_task_id) {
      const task = db.executionTasks.get(session.execution_task_id);
      if (task?.output_path) {
        console.log(`  Task log: ${task.output_path}`);
      }
    }
    const recent = JSON.parse(progress.recent_activities_json) as Array<{ at: string; summary: string }>;
    if (recent.length > 0) {
      console.log("");
      console.log(chalk.bold("Recent activities"));
      for (const item of recent.slice(-5)) {
        console.log(`  ${item.at} ${item.summary}`);
      }
    }
  });
}

export function handoffsCommand(agent: string): void {
  withDb((db) => {
    const selector = resolveCheckpointSelector(db, agent);
    const handoffs = selector ? loadHandoffs(db, selector) : [];
    if (handoffs.length === 0) { console.log(chalk.gray("No handoffs.")); return; }
    for (const h of handoffs) {
      const to = h.toSessionId ?? chalk.yellow("pending");
      console.log(`  ${h.reason}: ${h.fromSessionId.slice(0, 8)} -> ${typeof to === "string" && to.length > 8 ? to.slice(0, 8) : to} (${h.handoffAt})`);
    }
  });
}

export function contractShowCommand(contractId: string, feature: string, opts: { json: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const contract = ctx.contracts.loadContract(contractId, feature);
    if (!contract) { console.log(chalk.red("Contract not found.")); return; }
    if (opts.json) { console.log(JSON.stringify(contract, null, 2)); return; }
    console.log(chalk.bold(`Contract: ${contract.id}`));
    console.log(`  Agent: ${contract.agentName}`);
    console.log(`  Feature: ${contract.feature}`);
    console.log(`  Status: ${contract.status}`);
    console.log(`  Criteria: ${contract.acceptanceCriteria.length}`);
    if (contract.reviewedBy) console.log(`  Reviewed by: ${contract.reviewedBy}`);
  });
}

export function contractAcceptCommand(contractId: string, feature: string, reviewer: string, notes?: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const result = ctx.contracts.accept(contractId, feature, reviewer, notes);
    console.log(result ? chalk.green(`Contract ${contractId} accepted.`) : chalk.red("Contract not found."));
  });
}

export function contractRejectCommand(contractId: string, feature: string, reviewer: string, notes: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const result = ctx.contracts.reject(contractId, feature, reviewer, notes);
    console.log(result ? chalk.yellow(`Contract ${contractId} rejected.`) : chalk.red("Contract not found."));
  });
}

export function gradeCommand(rubricName: string): void {
  const rubric = getRubric(rubricName);
  console.log(chalk.bold(`Grading Rubric: ${rubricName}`));
  console.log(`  Pass threshold: ${(rubric.passThreshold * 100).toFixed(0)}%`);
  console.log("");
  for (const c of rubric.criteria) {
    console.log(`  ${c.name} (weight: ${(c.weight * 100).toFixed(0)}%, threshold: ${(c.threshold * 100).toFixed(0)}%)`);
    console.log(`    ${c.description}`);
    console.log("");
  }
}
