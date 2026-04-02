import chalk from "chalk";

import type { Capability } from "../types.js";
import { CapabilitySchema } from "../types.js";
import * as tmux from "../tmux.js";
import { isOrchestratorRunning } from "../config.js";
import { withDb, buildContext } from "./context.js";
import { startCommand } from "./orchestrator.js";

export function slingCommand(feature: string, profile?: string, runtime?: string): void {
  // Ensure the orchestrator daemon is running
  if (!isOrchestratorRunning()) {
    console.log(chalk.gray("  Starting orchestrator daemon..."));
    if (!startCommand()) {
      throw new Error("Failed to start orchestrator daemon.");
    }
  }

  withDb((db) => {
    const ctx = buildContext(db);
    const proposalResults = ctx.dispatcher.dispatchFeature(feature, profile);
    const spawnResults = ctx.execution.spawnAccepted(
      feature,
      profile,
      runtime ?? ctx.config.agents.runtime,
    );
    const results = [...proposalResults, ...spawnResults];
    for (const r of results) {
      const icon = r.status === "spawned"
        ? chalk.green("✓")
        : r.status === "proposed"
          ? chalk.yellow("•")
          : r.status === "error"
            ? chalk.red("✗")
            : chalk.gray("-");
      console.log(`  ${icon} ${r.task} — ${r.agent || r.contractId || r.error || r.status}`);
    }
  });
}

export function agentsListCommand(opts: { state?: string; json: boolean }): void {
  withDb((db) => {
    const sessions = opts.state
      ? db.sessions.list({ state: opts.state })
      : db.sessions.list();

    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (sessions.length === 0) {
      console.log(chalk.gray("No agents found."));
      return;
    }
    for (const s of sessions) {
      console.log(`  ${s.name} [${s.runtime}/${s.capability}] ${s.state} — ${s.feature ?? "-"}`);
    }
  });
}

export function spawnCommand(capability: string, name: string, opts: {
  task: string;
  feature: string;
  baseBranch: string;
  runId?: string;
  runtime?: string;
}): void {
  const cap = CapabilitySchema.parse(capability);
  withDb((db) => {
    const ctx = buildContext(db);
    const run = opts.runId
      ? ctx.db.runs.get(opts.runId)
      : ctx.db.runs.activeForFeature(opts.feature) ?? ctx.db.runs.latestForFeature(opts.feature);
    if (!run || run.feature !== opts.feature) {
      throw new Error(`No run found for feature ${opts.feature}${opts.runId ? ` (${opts.runId})` : ""}`);
    }
    const identity = ctx.agents.allocateIdentity(name);
    const info = ctx.agents.spawn({
      identity,
      runtimeId: opts.runtime ?? ctx.config.agents.runtime,
      capability: cap,
      feature: opts.feature,
      taskPrompt: opts.task,
      runId: run.id,
      baseBranch: opts.baseBranch,
    });
    console.log(chalk.green(`Spawned ${info.name} [${info.capability}]`));
    console.log(`  Branch: ${info.branch}`);
    console.log(`  Worktree: ${info.worktreePath}`);
    console.log(`  tmux: ${info.tmuxSession}`);
  });
}

export function stopAgentCommand(name: string, opts: { force: boolean; clean: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    ctx.agents.stop(name, opts);
    console.log(chalk.yellow(`Stopped ${name}`));
  });
}

export function inspectCommand(name: string, opts: { json: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const result = ctx.agents.inspect(name);
    if (!result) {
      console.log(chalk.red(`Agent ${name} not found.`));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result.session, null, 2));
      return;
    }
    const s = result.session;
    console.log(chalk.bold(s.name));
    console.log(`  Runtime: ${s.runtime}`);
    console.log(`  Capability: ${s.capability}`);
    console.log(`  Feature: ${s.feature}`);
    console.log(`  State: ${s.state}`);
    console.log(`  Branch: ${s.branch}`);
    console.log(`  Worktree: ${s.worktreePath}`);
    console.log(`  Transcript: ${s.transcriptPath}`);
    if (s.taskLogPath) console.log(`  Task log: ${s.taskLogPath}`);
    console.log(`  PID: ${s.pid}`);
    console.log(`  Started: ${s.startedAt}`);
    if (s.durationMs !== undefined) console.log(`  Duration: ${s.durationMs}ms`);
    if (s.toolUseCount !== undefined) console.log(`  Tool uses: ${s.toolUseCount}`);
    if (s.inputTokens !== undefined || s.outputTokens !== undefined) {
      console.log(`  Tokens: in=${s.inputTokens ?? 0} out=${s.outputTokens ?? 0}`);
    }
    if ((s.costUsd ?? 0) > 0) console.log(`  Cost: $${(s.costUsd ?? 0).toFixed(4)}`);
    if (s.progressSummary) console.log(`  Summary: ${s.progressSummary}`);
    if (s.lastActivitySummary) console.log(`  Last activity: ${s.lastActivitySummary}`);
    if (s.lastActivityAt) console.log(`  Last activity at: ${s.lastActivityAt}`);
    if (s.recentActivities && s.recentActivities.length > 0) {
      console.log("");
      console.log(chalk.bold("Recent activities:"));
      for (const activity of s.recentActivities.slice(-5)) {
        console.log(`  ${activity.at} [${activity.kind}] ${activity.summary}`);
      }
    }
    if (result.recentOutput) {
      console.log("");
      console.log(chalk.bold("Recent output:"));
      console.log(result.recentOutput);
    }
  });
}

export function nudgeCommand(name: string, text: string): void {
  const sessionName = tmux.sessionNameFor(name);
  const ok = tmux.sendKeys(sessionName, text);
  console.log(ok ? chalk.green("Nudged.") : chalk.red("Failed to nudge."));
}

export function heartbeatCommand(name: string): void {
  withDb((db) => {
    db.sessions.heartbeat(name);
    console.log(chalk.green("Heartbeat recorded."));
  });
}

export function evaluateCommand(feature: string, runtime?: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const result = ctx.execution.requestEvaluation(
      feature,
      runtime ?? ctx.config.agents.runtime,
    );

    switch (result.status) {
      case "spawned":
        console.log(chalk.green(`Spawned evaluator: ${result.agent}`));
        return;
      case "idle":
      case "blocked":
        throw new Error(result.reason);
      case "error":
        throw new Error(result.error);
    }
  });
}
