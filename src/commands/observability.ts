import chalk from "chalk";

import { openDb, withDb, buildContext } from "./context.js";
import { runDashboard } from "../dashboard.js";
import {
  loadCheckpoint,
  loadHandoffs,
  loadProgressArtifact,
  type CheckpointSelector,
} from "../checkpoint.js";
import { getRubric } from "../grading.js";

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
  });
}

export function progressCommand(agent: string): void {
  withDb((db) => {
    const selector = resolveCheckpointSelector(db, agent);
    const progress = selector ? loadProgressArtifact(db, selector) : null;
    console.log(progress ?? chalk.gray("No progress artifact found."));
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
