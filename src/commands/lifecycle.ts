import chalk from "chalk";

import { persistJsonArtifact } from "../artifacts.js";
import { RunPhaseSchema } from "../types.js";
import type { RunRow } from "../types.js";
import { Lifecycle } from "../lifecycle.js";
import { EventEmitter } from "../events.js";
import { requestCanonicalVerification } from "../verify.js";
import { withDb, buildContext } from "./context.js";

export function phaseGetCommand(feature: string): void {
  withDb((db) => {
    const lifecycle = new Lifecycle(db);
    const phase = lifecycle.getFeaturePhase(feature);
    console.log(phase ?? chalk.gray("not tracked"));
  });
}

export function phaseAdvanceCommand(feature: string, target: string): void {
  const targetPhase = RunPhaseSchema.parse(target);
  withDb((db) => {
    const events = new EventEmitter(db);
    const lifecycle = new Lifecycle(db, events);
    const run = lifecycle.latestRun(feature);
    if (!run) {
      console.log(chalk.red(`No run found for feature ${feature}`));
      return;
    }
    lifecycle.advanceRun(run.id, targetPhase);
    console.log(chalk.green(`Advanced run ${run.id} to ${target}`));
  });
}

export function phaseListCommand(): void {
  withDb((db) => {
    const lifecycle = new Lifecycle(db);
    const features = lifecycle.listFeatures();
    if (features.length === 0) {
      console.log(chalk.gray("No features tracked."));
      return;
    }
    for (const f of features) {
      console.log(`  ${f.feature}: ${f.phase}${f.reviewVerdict ? ` (${f.reviewVerdict})` : ""}`);
    }
  });
}

export function runListCommand(feature?: string, opts?: { json: boolean }): void {
  withDb((db) => {
    let runs: RunRow[];
    if (feature) {
      runs = db.runs.listByFeature(feature);
    } else {
      runs = db.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all() as RunRow[];
    }

    if (opts?.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log(chalk.gray("No runs found."));
      return;
    }
    for (const r of runs) {
      const artifacts = db.artifacts.listByRun(r.id);
      console.log(`  ${r.id} [${r.feature}] ${r.status} — ${artifacts.length} artifact(s) — ${r.created_at}`);
    }
  });
}

export function runShowCommand(runId: string, opts?: { json: boolean }): void {
  withDb((db) => {
    const run = db.runs.get(runId);
    if (!run) {
      console.log(chalk.red(`Run ${runId} not found.`));
      return;
    }

    if (opts?.json) {
      const artifacts = db.artifacts.listByRun(runId);
      const scopes = db.reviewScopes.listByRun(runId);
      const sessions = db.sessions.list({ run_id: runId });
      const merges = db.merges.listForRun(runId);
      console.log(JSON.stringify({ run, artifacts, scopes, sessions, merges }, null, 2));
      return;
    }

    console.log(chalk.bold(`Run: ${run.id}`));
    console.log(`  Feature: ${run.feature}`);
    console.log(`  Phase: ${run.status}`);
    if (run.phase_reason) console.log(`  Reason: ${run.phase_reason}`);
    if (run.profile) console.log(`  Profile: ${run.profile}`);
    console.log(`  Created: ${run.created_at}`);
    console.log(`  Updated: ${run.updated_at}`);

    const artifacts = db.artifacts.listByRun(runId);
    if (artifacts.length > 0) {
      console.log(`  Artifacts: ${artifacts.length}`);
      for (const a of artifacts) {
        console.log(`    ${a.type}: ${a.path} (${a.hash})`);
      }
    }

    const scopes = db.reviewScopes.listByRun(runId);
    if (scopes.length > 0) {
      console.log(`  Review scopes: ${scopes.length}`);
      for (const s of scopes) {
        console.log(`    ${s.id}: ${s.scope_status} ${s.verdict ?? ""}`);
      }
    }
  });
}

export function runResetCommand(runId: string, opts?: { reason?: string }): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const archivePath = ctx.lifecycle.resetRun(runId, opts?.reason);
    const run = db.runs.get(runId);
    console.log(chalk.green(`Reset run ${runId} to ${run?.status ?? "unknown"}.`));
    console.log(`  Archive: ${archivePath}`);
  });
}

export function shipCommand(feature: string): void {
  withDb((db) => {
    const ctx = buildContext(db);
    const lifecycle = new Lifecycle(db, ctx.events, ctx.projectRoot);
    const run = lifecycle.latestRun(feature);
    if (!run) {
      console.log(chalk.red(`No run found for feature ${feature}`));
      return;
    }

    const approvedScope = db.reviewScopes.latestApproved(run.id);
    if (!approvedScope) {
      console.log(chalk.red(`Cannot ship: no approved review scope for run ${run.id}`));
      return;
    }

    const verifyCommands = JSON.parse(approvedScope.verify_commands) as string[];
    let verification = requestCanonicalVerification({
      db,
      runId: run.id,
      feature,
      scopeId: approvedScope.id,
      scopeHash: approvedScope.scope_hash,
      canonicalBranch: ctx.config.project.canonicalBranch,
      commands: verifyCommands,
      projectRoot: ctx.projectRoot,
    });
    ctx.execution.reconcileRuns();
    verification = requestCanonicalVerification({
      db,
      runId: run.id,
      feature,
      scopeId: approvedScope.id,
      scopeHash: approvedScope.scope_hash,
      canonicalBranch: ctx.config.project.canonicalBranch,
      commands: verifyCommands,
      projectRoot: ctx.projectRoot,
    });

    if (verification.status === "scheduled" || verification.status === "running") {
      console.log(chalk.yellow(`Canonical verification started for ${feature}.`));
      console.log(chalk.gray("  Re-run `cnog ship <feature>` once verification completes."));
      return;
    }

    if (verification.status === "failed" || verification.status === "blocked" || !verification.artifact) {
      console.log(chalk.red(`Cannot ship: canonical verification ${verification.status}`));
      return;
    }

    const verifyArtifact = verification.artifact;

    const [canShip, reason] = lifecycle.canShip(run.id);
    if (!canShip) {
      console.log(chalk.red(`Cannot ship: ${reason}`));
      return;
    }

    if (run.status === "merge") {
      lifecycle.advanceRun(run.id, "ship", "Canonical verification passed for approved scope");
    }

    persistJsonArtifact({
      db,
      artifactId: `art-ship-${run.id}-${Date.now()}`,
      runId: run.id,
      feature,
      type: "ship-report",
      filename: `ship-report-${run.id}-${Date.now()}.json`,
      data: {
        runId: run.id,
        feature,
        scopeId: approvedScope.id,
        scopeHash: approvedScope.scope_hash,
        verifyArtifactId: verifyArtifact.id,
        canonicalBranch: ctx.config.project.canonicalBranch,
        shippedAt: new Date().toISOString(),
      },
      projectRoot: ctx.projectRoot,
      reviewScopeId: approvedScope.id,
    });

    console.log(chalk.green(`Feature ${feature} is ready to ship.`));
    console.log("  Use gh CLI to create the PR:");
    console.log(`  gh pr create --title "feat: ${feature}" --body "..."`);
  });
}
