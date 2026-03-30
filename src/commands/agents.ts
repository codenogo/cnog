import chalk from "chalk";

import type { Capability } from "../types.js";
import { CapabilitySchema } from "../types.js";
import * as tmux from "../tmux.js";
import {
  buildContractEvaluationSpec,
  buildContractReviewCompletionCommand,
  buildImplementationReviewCompletionCommand,
  buildReviewScope,
  buildRunEvaluationSpec,
} from "../review.js";
import { withDb, buildContext } from "./context.js";

export function slingCommand(feature: string, profile?: string, runtime?: string): void {
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
    console.log(`  PID: ${s.pid}`);
    console.log(`  Started: ${s.startedAt}`);
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
    const run = ctx.lifecycle.latestRun(feature);
    if (!run) {
      throw new Error(`No run found for feature ${feature}`);
    }

    const identity = ctx.agents.allocateIdentity(`evaluator-${feature}`);
    let info;

    if (run.status === "contract") {
      const contractSpec = buildContractEvaluationSpec({
        runId: run.id,
        feature,
        db: ctx.db,
        projectRoot: ctx.projectRoot,
      });
      info = ctx.agents.spawn({
        identity,
        runtimeId: runtime ?? ctx.config.agents.runtime,
        capability: "evaluator",
        feature,
        taskPrompt: contractSpec.taskPrompt,
        runId: run.id,
        verifyCommands: contractSpec.verifyCommands,
        baseBranch: ctx.config.project.canonicalBranch,
        completionCommand: buildContractReviewCompletionCommand(
          identity.name,
          contractSpec.contractIds ?? [],
        ),
      });
    } else {
      const remainingIssues = ctx.db.issues
        .list({ run_id: run.id })
        .filter((issue) => issue.status === "open" || issue.status === "in_progress");
      const activeBuilders = ctx.db.sessions.list({ run_id: run.id })
        .filter((session) =>
          session.capability === "builder"
          && session.state !== "completed"
          && session.state !== "failed",
        );
      const pendingBranches = ctx.db.merges.pendingForRun(run.id);

      if (remainingIssues.length > 0 || activeBuilders.length > 0) {
        throw new Error(
          `Feature ${feature} still has implementation work in flight. Finish all builders before evaluation.`,
        );
      }

      if (pendingBranches.length === 0) {
        throw new Error(`Feature ${feature} has no completed branches ready for evaluation.`);
      }

      if (run.status === "build") {
        ctx.lifecycle.advanceRun(run.id, "evaluate");
      } else if (run.status !== "evaluate") {
        throw new Error(
          `Feature ${feature} is in ${run.status} phase. Complete implementation before evaluation.`,
        );
      }

      let scope = ctx.db.reviewScopes.activeForRun(run.id);
      if (!scope) {
        const scopeId = buildReviewScope({
          runId: run.id,
          feature,
          db: ctx.db,
          projectRoot: ctx.projectRoot,
        });
        ctx.events.scopeCreated(scopeId, run.id, feature);
        scope = ctx.db.reviewScopes.get(scopeId)!;
      }

      const reviewSpec = buildRunEvaluationSpec({
        runId: run.id,
        scopeId: scope.id,
        db: ctx.db,
        canonicalBranch: ctx.config.project.canonicalBranch,
        projectRoot: ctx.projectRoot,
      });

      info = ctx.agents.spawn({
        identity,
        runtimeId: runtime ?? ctx.config.agents.runtime,
        capability: "evaluator",
        feature,
        taskPrompt: reviewSpec.taskPrompt,
        runId: run.id,
        verifyCommands: reviewSpec.verifyCommands,
        rubric: reviewSpec.rubric,
        baseBranch: ctx.config.project.canonicalBranch,
        completionCommand: buildImplementationReviewCompletionCommand(identity.name),
      });
      ctx.db.reviewScopes.updateStatus(scope.id, "evaluating");
    }
    console.log(chalk.green(`Spawned evaluator: ${info.name}`));
  });
}
