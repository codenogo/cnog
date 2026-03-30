import chalk from "chalk";

import { findProjectRoot } from "../paths.js";
import { loadLatestPlan, createBlankPlan, writePlan, renderPlanMd, validatePlan } from "../planning/plan-factory.js";
import { Lifecycle } from "../lifecycle.js";
import { EventEmitter } from "../events.js";
import { withDb, buildContext } from "./context.js";

export function planCommand(feature: string, opts: { profile?: string; json: boolean; validate: boolean }): void {
  const projectRoot = findProjectRoot();
  const plan = loadLatestPlan(feature, projectRoot);
  if (!plan) { console.log(chalk.red(`No plan found for ${feature}`)); return; }
  if (opts.validate) {
    const errors = validatePlan(plan);
    if (errors.length === 0) { console.log(chalk.green("Plan is valid.")); }
    else { for (const e of errors) console.log(chalk.red(`  ${e.field}: ${e.message}`)); }
    return;
  }
  console.log(opts.json ? JSON.stringify(plan, null, 2) : renderPlanMd(plan));
}

export function shapeCommand(feature: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const plan = createBlankPlan(feature, ctx.projectRoot);
    const path = writePlan(plan, ctx.projectRoot);

    // Create a run for this feature in plan phase
    const runId = `run-${feature}-${Date.now()}`;
    db.runs.create({
      id: runId,
      feature,
      plan_number: plan.planNumber,
      status: "plan",
      phase_reason: null,
      profile: null,
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });
    // Sync derived cache
    db.phases.set(feature, "plan");

    console.log(chalk.green(`Feature ${feature} initialized.`));
    console.log(`  Run: ${runId}`);
    console.log(`  Plan template: ${path}`);
    console.log(`  Phase: plan`);
  });
}

export function mergeCommand(opts: { feature?: string; all: boolean; dryRun: boolean }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    if (opts.dryRun) {
      const pending = ctx.mergeQueue.pending(opts.feature);
      console.log(`${pending.length} pending merge(s)`);
      for (const p of pending) console.log(`  ${p.branch} (${p.feature})`);
      return;
    }
    const results = opts.all
      ? ctx.mergeQueue.processAll()
      : (() => { const r = ctx.mergeQueue.processNext(); return r ? [r] : []; })();
    for (const r of results) {
      const icon = r.success ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${r.message}`);
    }
  });
}
