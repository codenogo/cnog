/**
 * Run-authoritative lifecycle management.
 *
 * Canonical run phases: plan -> contract -> build -> evaluate -> merge -> ship -> done -> failed
 *
 * Rework is normal:
 *   evaluate -> build    (implementation failed, scope valid)
 *   evaluate -> contract (contract was wrong/incomplete)
 *   merge -> build       (conflicts reveal invalid assumptions)
 *   merge -> failed      (unrecoverable merge conflict)
 *   failed -> plan       (restart from scratch)
 *
 * Feature phases are derived from the latest run for the feature.
 * The feature_phases table is kept as a derived cache for backward compatibility.
 */

import type { CnogDB } from "./db.js";
import { EventEmitter } from "./events.js";
import type { RunPhase, RunRow } from "./types.js";
import { loadArtifactJson } from "./artifacts.js";
import { loadContractFromArtifact } from "./contracts.js";
import { computeCurrentScopeHash } from "./review.js";
import { RunController } from "./run-controller.js";

interface VerifyReportArtifact {
  mode?: "canonical" | "issue" | "review_scope";
  scopeHash: string;
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Transition map
// ---------------------------------------------------------------------------

const RUN_TRANSITIONS: Record<RunPhase, RunPhase[]> = {
  plan:     ["contract", "failed"],
  contract: ["build", "failed"],
  build:    ["evaluate", "failed"],
  evaluate: ["build", "contract", "merge", "failed"],
  merge:    ["build", "ship", "done", "failed"],
  ship:     ["done", "failed"],
  done:     [],
  failed:   ["plan"],
};

/** Map run phase to the legacy feature_phases phase for the derived cache. */
const PHASE_TO_FEATURE_PHASE: Record<RunPhase, string> = {
  plan:     "plan",
  contract: "plan",
  build:    "implement",
  evaluate: "review",
  merge:    "review",
  ship:     "ship",
  done:     "ship",
  failed:   "discuss",
};

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export class Lifecycle {
  constructor(
    private readonly db: CnogDB,
    private readonly events?: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  // =========================================================================
  // Run lifecycle (authoritative)
  // =========================================================================

  /**
   * Get current phase for a run.
   */
  getRunPhase(runId: string): RunPhase | undefined {
    const run = this.db.runs.get(runId);
    return run?.status as RunPhase | undefined;
  }

  /**
   * Check if a transition is allowed.
   */
  canAdvance(runId: string, target: RunPhase): [boolean, string] {
    const run = this.db.runs.get(runId);
    if (!run) {
      return [false, `Run ${runId} not found`];
    }

    const current = run.status as RunPhase;
    const allowed = RUN_TRANSITIONS[current];

    if (!allowed || !allowed.includes(target)) {
      return [false, `Cannot transition run ${runId} from ${current} to ${target}. Allowed: ${(allowed ?? []).join(", ") || "none (terminal)"}`];
    }

    // Check prerequisites for specific transitions
    const [prereqOk, prereqReason] = this.checkRunPrerequisites(run, current, target);
    if (!prereqOk) {
      return [false, prereqReason];
    }

    return [true, `${current} -> ${target}`];
  }

  /**
   * Advance a run to a target phase.
   */
  advanceRun(runId: string, target: RunPhase, reason?: string): void {
    const run = this.db.runs.get(runId);
    if (!run) {
      throw new LifecycleError(`Run ${runId} not found`);
    }

    const current = run.status as RunPhase;
    const [canDo, message] = this.canAdvance(runId, target);
    if (!canDo) {
      throw new LifecycleError(message);
    }

    this.db.runs.update(runId, { status: target, phase_reason: reason ?? null });

    // Update the derived feature_phases cache
    this.syncFeaturePhaseCache(run.feature, target);

    this.events?.phaseAdvanced(run.feature, current, target);
  }

  /**
   * Archive a run snapshot and reset it to a clean executable state.
   * This is safer than trying to mutate a half-broken run in place.
   */
  resetRun(runId: string, reason: string = "manual_reset"): string {
    const run = this.db.runs.get(runId);
    if (!run) {
      throw new LifecycleError(`Run ${runId} not found`);
    }

    const merges = this.db.merges.listForRun(runId);
    if (merges.some((entry) => entry.status === "merged")) {
      throw new LifecycleError(`Run ${runId} already has merged entries and cannot be reset safely`);
    }

    const targetPhase = this.resetTargetPhase(runId);
    const controller = new RunController(
      this.db,
      this.events ?? new EventEmitter(this.db),
      this.projectRoot,
    );
    const { archivePath } = controller.resetRun(runId, reason, targetPhase);
    this.syncFeaturePhaseCache(run.feature, targetPhase);

    this.events?.emit({
      source: "lifecycle",
      eventType: "run_reset",
      message: `Run ${run.id} reset to ${targetPhase}`,
      feature: run.feature,
      data: { runId: run.id, reason, archivePath },
    });

    return archivePath;
  }

  /**
   * Check if a run's pending merge scope can be merged.
   * Requires an approved review scope whose hash matches current state.
   */
  canMerge(runId: string): [boolean, string] {
    const run = this.db.runs.get(runId);
    if (!run) {
      return [false, `Run ${runId} not found`];
    }

    const phase = run.status as RunPhase;
    if (phase !== "merge" && phase !== "evaluate") {
      return [false, `Run is in ${phase} phase, need merge or evaluate`];
    }

    const approved = this.db.reviewScopes.latestApproved(runId);
    if (!approved) {
      return [false, "No approved review scope for this run"];
    }

    const currentScopeHash = computeCurrentScopeHash(runId, this.db, this.projectRoot);
    if (approved.scope_hash !== currentScopeHash) {
      return [false, "Approved scope hash no longer matches current pending state (scope drift)"];
    }

    return [true, "approved review scope matches"];
  }

  /**
   * Check if a run is ready for shipping.
   * Requires: approved review scope + all scope entries merged + canonical branch clean.
   */
  canShip(runId: string): [boolean, string] {
    const run = this.db.runs.get(runId);
    if (!run) {
      return [false, `Run ${runId} not found`];
    }

    const phase = run.status as RunPhase;
    if (phase === "done") {
      return [true, "already done"];
    }

    if (phase !== "merge" && phase !== "ship") {
      return [false, `Run is in ${phase} phase, need merge or ship`];
    }

    const approved = this.db.reviewScopes.latestApproved(runId);
    if (!approved) {
      return [false, "No approved review scope"];
    }

    // Check all merge entries in the approved scope are actually merged
    const scopeEntryIds = JSON.parse(approved.merge_entries) as number[];
    if (scopeEntryIds.length === 0) {
      return [false, "Approved scope has no merge entries"];
    }

    const allMerges = this.db.merges.listForRun(runId);
    for (const entryId of scopeEntryIds) {
      const entry = allMerges.find((m) => m.id === entryId);
      if (!entry) {
        return [false, `Merge entry ${entryId} from scope not found`];
      }
      if (entry.status !== "merged") {
        return [false, `Merge entry ${entryId} (${entry.branch}) is ${entry.status}, not merged`];
      }
    }

    const verifyArtifacts = this.db.artifacts.listByRun(runId, "verify-report");
    const matchingVerify = [...verifyArtifacts].reverse().find((artifact) => {
      const report = loadArtifactJson<VerifyReportArtifact>(artifact, this.projectRoot);
      return report?.scopeHash === approved.scope_hash
        && (report.mode === "canonical" || report.mode == null);
    });

    if (!matchingVerify) {
      return [false, "No final canonical verify report for the approved scope"];
    }

    const verifyReport = loadArtifactJson<VerifyReportArtifact>(matchingVerify, this.projectRoot);
    if (!verifyReport?.passed) {
      return [false, "Final canonical verification did not pass for the approved scope"];
    }

    return [true, "approved scope fully merged and canonically verified"];
  }

  // =========================================================================
  // Feature convenience (derived from latest run)
  // =========================================================================

  /**
   * Get the run phase of the latest run for a feature.
   */
  getFeaturePhase(feature: string): RunPhase | undefined {
    const run = this.db.runs.latestForFeature(feature);
    return run?.status as RunPhase | undefined;
  }

  /**
   * Get the latest run for a feature.
   */
  latestRun(feature: string): RunRow | undefined {
    return this.db.runs.latestForFeature(feature);
  }

  /**
   * List all features with their derived phase from latest run.
   */
  listFeatures(): Array<{ feature: string; phase: RunPhase; reviewVerdict: string | null }> {
    const rows = this.db.db.prepare(
      "SELECT * FROM runs ORDER BY created_at DESC, rowid DESC",
    ).all() as RunRow[];
    const latestByFeature = new Map<string, RunRow>();

    for (const row of rows) {
      if (!latestByFeature.has(row.feature)) {
        latestByFeature.set(row.feature, row);
      }
    }

    return [...latestByFeature.entries()].map(([feature, run]) => {
      const scope = this.db.reviewScopes.activeForRun(run.id)
        ?? this.db.reviewScopes.listByRun(run.id)[0];
      return {
        feature,
        phase: run.status as RunPhase,
        reviewVerdict: scope?.verdict ?? null,
      };
    });
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * Check prerequisites for a run phase transition.
   */
  private checkRunPrerequisites(run: RunRow, from: RunPhase, to: RunPhase): [boolean, string] {
    // plan -> contract: plan artifact must exist
    if (from === "plan" && to === "contract") {
      const planArtifacts = this.db.artifacts.listByRun(run.id, "plan");
      if (planArtifacts.length === 0) {
        return [false, `No plan artifact registered for run ${run.id}`];
      }
    }

    // contract -> build: at least one accepted contract must exist
    if (from === "contract" && to === "build") {
      const contractArtifacts = this.db.artifacts.listByRun(run.id, "contract");
      const latestByIssue = new Map<string, typeof contractArtifacts[number]>();
      for (const artifact of contractArtifacts) {
        latestByIssue.set(artifact.issue_id ?? artifact.id, artifact);
      }
      const hasAcceptedContract = [...latestByIssue.values()].some((artifact) => {
        const contract = loadContractFromArtifact(artifact, this.projectRoot);
        return contract?.status === "accepted";
      });
      if (!hasAcceptedContract) {
        return [false, `No accepted contracts for run ${run.id}`];
      }
    }

    // evaluate -> merge: requires approved review scope
    if (from === "evaluate" && to === "merge") {
      const [canMergeOk, reason] = this.canMerge(run.id);
      if (!canMergeOk) {
        return [false, reason];
      }
    }

    // merge -> ship: all entries merged
    if (from === "merge" && to === "ship") {
      const [canShipOk, reason] = this.canShip(run.id);
      if (!canShipOk) {
        return [false, reason];
      }
    }

    return [true, "ok"];
  }

  /**
   * Sync the derived feature_phases cache from a run phase change.
   */
  private syncFeaturePhaseCache(feature: string, runPhase: RunPhase): void {
    const mappedPhase = PHASE_TO_FEATURE_PHASE[runPhase] ?? "discuss";
    this.db.phases.set(feature, mappedPhase);
  }

  private resetTargetPhase(runId: string): RunPhase {
    const run = this.db.runs.get(runId);
    if (!run) {
      return "plan";
    }

    const planArtifacts = this.db.artifacts.listByRun(runId, "plan");
    if (planArtifacts.length === 0) {
      return "plan";
    }

    const rootIssues = this.db.issues
      .list({ run_id: runId })
      .filter((issue) => this.db.issues.getDeps(issue.id).length === 0);
    if (rootIssues.length === 0) {
      return "contract";
    }

    const latestContracts = rootIssues.map((issue) => {
      const artifacts = this.db.artifacts
        .listByIssue(issue.id)
        .filter((artifact) => artifact.type === "contract");
      for (let i = artifacts.length - 1; i >= 0; i -= 1) {
        const contract = loadContractFromArtifact(artifacts[i], this.projectRoot);
        if (contract) return contract;
      }
      return null;
    });

    const readyForBuild = latestContracts.every((contract) =>
      contract && (contract.status === "accepted" || contract.status === "completed"),
    );

    return readyForBuild ? "build" : "contract";
  }
}
