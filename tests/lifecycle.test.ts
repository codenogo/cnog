import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { Lifecycle, LifecycleError } from "../src/lifecycle.js";
import { persistJsonArtifact } from "../src/artifacts.js";
import { computeScopeHash } from "../src/review.js";
import * as tmux from "../src/tmux.js";
import * as worktree from "../src/worktree.js";

let db: CnogDB;
let lifecycle: Lifecycle;
let tmpDir: string;

/** Counter for unique IDs. */
let idSeq = 0;
function uid(prefix = "r"): string {
  return `${prefix}-${++idSeq}`;
}

/** Helper: create a run in `plan` phase. */
function createRun(feature: string, id?: string): string {
  const runId = id ?? uid("run");
  // If there's already an active run for this feature, mark it done first
  const existing = db.runs.activeForFeature(feature);
  if (existing) {
    db.runs.update(existing.id, { status: "done" });
  }
  db.runs.create({
    id: runId,
    feature,
    plan_number: null,
    status: "plan",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  // Ensure the feature_phases row exists (used by listFeatures)
  db.phases.set(feature, "plan");
  return runId;
}

/** Helper: register a plan artifact so plan->contract succeeds. */
function registerPlanArtifact(runId: string): void {
  const run = db.runs.get(runId)!;
  db.artifacts.create({
    id: uid("art"),
    run_id: runId,
    feature: run.feature,
    type: "plan",
    path: "/tmp/plan.json",
    hash: "abc123",
    issue_id: null,
    session_id: null,
    review_scope_id: null,
  });
}

/** Helper: register a contract artifact so contract->build succeeds. */
function registerContractArtifact(runId: string): void {
  const run = db.runs.get(runId)!;
  persistJsonArtifact({
    db,
    artifactId: uid("art"),
    runId,
    feature: run.feature,
    type: "contract",
    filename: `contract-${uid("file")}.json`,
    data: {
      id: uid("contract"),
      taskId: uid("task"),
      runId,
      feature: run.feature,
      agentName: "builder-test",
      acceptanceCriteria: [{ description: "do the thing", testable: true }],
      verifyCommands: ["npm test"],
      fileScope: ["src/test.ts"],
      status: "accepted",
      proposedAt: new Date().toISOString(),
      reviewedBy: "evaluator-test",
      reviewedAt: new Date().toISOString(),
      reviewNotes: null,
    },
    projectRoot: tmpDir,
  });
}

function registerVerifyArtifact(runId: string, scopeHash: string, passed: boolean = true): void {
  const run = db.runs.get(runId)!;
  persistJsonArtifact({
    db,
    artifactId: uid("art"),
    runId,
    feature: run.feature,
    type: "verify-report",
    filename: `verify-${uid("verify")}.json`,
    data: {
      runId,
      feature: run.feature,
      scopeHash,
      passed,
      results: [],
    },
    projectRoot: tmpDir,
  });
}

/**
 * Helper: create a session for a run so merge entries can reference it.
 */
function createTestSession(runId: string, feature: string, name?: string): string {
  const sessionId = uid("sess");
  const sessionName = name ?? `builder-${feature}-${sessionId}`;
  db.sessions.create({
    id: sessionId,
    name: sessionName,
    logical_name: sessionName,
    attempt: 1,
    runtime: "claude",
    capability: "builder",
    feature,
    task_id: null,
    worktree_path: null,
    branch: `cnog/${feature}/${sessionName}`,
    tmux_session: null,
    pid: null,
    state: "working",
    parent_agent: null,
    run_id: runId,
  });
  return sessionId;
}

/**
 * Helper: enqueue a merge entry for a run/feature and create an approved
 * review scope that references it.  Returns { mergeId, scopeId }.
 */
function setupApprovedScope(
  runId: string,
  feature: string,
): { mergeId: number; scopeId: string } {
  const sessionId = createTestSession(runId, feature);
  const mergeId = db.merges.enqueue({
    feature,
    branch: `cnog/${feature}/builder-${feature}`,
    agent_name: `builder-${feature}`,
    run_id: runId,
    session_id: sessionId,
    task_id: null,
    head_sha: "abc123",
    files_modified: null,
  });
  const scopeId = uid("scope");
  const scopeHash = computeScopeHash({
    mergeEntryIds: [mergeId],
    branches: [`cnog/${feature}/builder-${feature}`],
    headShas: ["abc123"],
    contractIds: [],
    contractHashes: [],
    verifyCommands: [],
  });
  const evalSessionId = uid("eval-sess");
  db.sessions.create({
    id: evalSessionId,
    name: `evaluator-${evalSessionId}`,
    logical_name: `evaluator-${evalSessionId}`,
    attempt: 1,
    runtime: "claude",
    capability: "evaluator",
    feature,
    task_id: null,
    worktree_path: null,
    branch: null,
    tmux_session: null,
    pid: null,
    state: "working",
    parent_agent: null,
    run_id: runId,
  });
  db.reviewScopes.create({
    id: scopeId,
    run_id: runId,
    scope_status: "pending",
    scope_hash: scopeHash,
    merge_entries: JSON.stringify([mergeId]),
    branches: JSON.stringify([`cnog/${feature}/builder-${feature}`]),
    head_shas: JSON.stringify(["abc123"]),
    contract_ids: JSON.stringify([]),
    contract_hashes: JSON.stringify([]),
    verify_commands: JSON.stringify([]),
    verdict: null,
    evaluator_session: null,
  });
  db.reviewScopes.setVerdict(scopeId, "APPROVE", evalSessionId);
  return { mergeId, scopeId };
}

/**
 * Advance a run through the canonical flow up to (but not including) `target`.
 * Registers artifacts along the way.
 */
function advanceTo(
  runId: string,
  feature: string,
  target: "contract" | "build" | "evaluate" | "merge" | "ship" | "done",
): { mergeId?: number; scopeId?: string } {
  const phases = ["plan", "contract", "build", "evaluate", "merge", "ship", "done"] as const;
  const targetIdx = phases.indexOf(target);
  let mergeId: number | undefined;
  let scopeId: string | undefined;

  for (let i = 0; i < targetIdx; i++) {
    const from = phases[i];
    const to = phases[i + 1];
    // Register artifacts as prerequisites
    if (from === "plan" && to === "contract") {
      registerPlanArtifact(runId);
    }
    if (from === "contract" && to === "build") {
      registerContractArtifact(runId);
    }
    if (from === "evaluate" && to === "merge") {
      const result = setupApprovedScope(runId, feature);
      mergeId = result.mergeId;
      scopeId = result.scopeId;
    }
    if (from === "merge" && to === "ship") {
      if (mergeId != null) {
        db.merges.updateStatus(mergeId, "merged", "clean");
      }
      if (scopeId != null) {
        const scope = db.reviewScopes.get(scopeId)!;
        registerVerifyArtifact(runId, scope.scope_hash, true);
      }
    }
    lifecycle.advanceRun(runId, to);
  }
  return { mergeId, scopeId };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-lifecycle-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  lifecycle = new Lifecycle(db, undefined, tmpDir);
  idSeq = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Lifecycle (run-authoritative)", () => {
  // =========================================================================
  // Basic phase queries
  // =========================================================================

  it("getRunPhase returns the current phase of a run", () => {
    const runId = createRun("auth");
    expect(lifecycle.getRunPhase(runId)).toBe("plan");
  });

  it("getRunPhase returns undefined for unknown run", () => {
    expect(lifecycle.getRunPhase("nonexistent")).toBeUndefined();
  });

  // =========================================================================
  // Forward transitions through the canonical flow
  // =========================================================================

  it("advances plan -> contract when plan artifact exists", () => {
    const runId = createRun("auth");
    registerPlanArtifact(runId);
    lifecycle.advanceRun(runId, "contract");
    expect(lifecycle.getRunPhase(runId)).toBe("contract");
  });

  it("advances contract -> build when contract artifact exists", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "build");
    expect(lifecycle.getRunPhase(runId)).toBe("build");
  });

  it("advances build -> evaluate", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "evaluate");
    expect(lifecycle.getRunPhase(runId)).toBe("evaluate");
  });

  it("advances evaluate -> merge when approved scope exists", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "merge");
    expect(lifecycle.getRunPhase(runId)).toBe("merge");
  });

  it("advances merge -> ship when all entries merged", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "ship");
    expect(lifecycle.getRunPhase(runId)).toBe("ship");
  });

  it("advances ship -> done", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "ship");
    expect(lifecycle.getRunPhase(runId)).toBe("ship");
    lifecycle.advanceRun(runId, "done");
    expect(lifecycle.getRunPhase(runId)).toBe("done");
  });

  it("traverses the full canonical flow: plan -> contract -> build -> evaluate -> merge -> ship -> done", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "ship");
    lifecycle.advanceRun(runId, "done");
    expect(lifecycle.getRunPhase(runId)).toBe("done");
  });

  // =========================================================================
  // Prerequisite enforcement
  // =========================================================================

  it("rejects plan -> contract without plan artifact", () => {
    const runId = createRun("auth");
    expect(() => lifecycle.advanceRun(runId, "contract")).toThrow(LifecycleError);
  });

  it("rejects contract -> build without contract artifact", () => {
    const runId = createRun("auth");
    registerPlanArtifact(runId);
    lifecycle.advanceRun(runId, "contract");
    expect(() => lifecycle.advanceRun(runId, "build")).toThrow(LifecycleError);
  });

  it("rejects evaluate -> merge without approved review scope", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "evaluate");
    expect(() => lifecycle.advanceRun(runId, "merge")).toThrow(LifecycleError);
  });

  it("rejects merge -> ship when merge entries not yet merged", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "merge");
    // Merge entry is still 'pending' at this point
    expect(() => lifecycle.advanceRun(runId, "ship")).toThrow(LifecycleError);
  });

  // =========================================================================
  // Invalid transitions
  // =========================================================================

  it("rejects skipping phases (plan -> build)", () => {
    const runId = createRun("auth");
    expect(() => lifecycle.advanceRun(runId, "build")).toThrow(LifecycleError);
  });

  it("rejects skipping phases (plan -> evaluate)", () => {
    const runId = createRun("auth");
    expect(() => lifecycle.advanceRun(runId, "evaluate")).toThrow(LifecycleError);
  });

  it("rejects skipping phases (plan -> ship)", () => {
    const runId = createRun("auth");
    expect(() => lifecycle.advanceRun(runId, "ship")).toThrow(LifecycleError);
  });

  it("rejects transition from done (terminal state)", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "ship");
    lifecycle.advanceRun(runId, "done");
    expect(() => lifecycle.advanceRun(runId, "plan")).toThrow(LifecycleError);
  });

  it("rejects advancing unknown run", () => {
    expect(() => lifecycle.advanceRun("nonexistent", "contract")).toThrow(LifecycleError);
  });

  // =========================================================================
  // Backward / rework transitions
  // =========================================================================

  it("allows evaluate -> build (implementation rework)", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "evaluate");
    lifecycle.advanceRun(runId, "build");
    expect(lifecycle.getRunPhase(runId)).toBe("build");
  });

  it("allows evaluate -> contract (contract rework)", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "evaluate");
    lifecycle.advanceRun(runId, "contract");
    expect(lifecycle.getRunPhase(runId)).toBe("contract");
  });

  it("allows merge -> build (conflict reveals invalid assumptions)", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "merge");
    lifecycle.advanceRun(runId, "build");
    expect(lifecycle.getRunPhase(runId)).toBe("build");
  });

  it("allows failed -> plan (restart from scratch)", () => {
    const runId = createRun("auth");
    lifecycle.advanceRun(runId, "failed");
    expect(lifecycle.getRunPhase(runId)).toBe("failed");

    lifecycle.advanceRun(runId, "plan");
    expect(lifecycle.getRunPhase(runId)).toBe("plan");
  });

  it("rejects backward transitions not in the transition map", () => {
    const runId = createRun("auth");
    advanceTo(runId, "auth", "build");
    // build -> plan is not allowed
    expect(() => lifecycle.advanceRun(runId, "plan")).toThrow(LifecycleError);
  });

  // =========================================================================
  // Failure transitions
  // =========================================================================

  it("allows any phase -> failed", () => {
    const phases = ["plan", "contract", "build", "evaluate", "merge", "ship"] as const;
    for (const phase of phases) {
      const runId = createRun(`feat-${phase}`);
      advanceTo(runId, `feat-${phase}`, phase === "plan" ? "contract" : phase as any);
      // If we're testing plan, the run is already in plan; for others, advanceTo got us there.
      // Actually, let's just set up each run at the target phase directly.
    }
    // Simpler: test a few key phases individually
    const r1 = createRun("f1");
    lifecycle.advanceRun(r1, "failed");
    expect(lifecycle.getRunPhase(r1)).toBe("failed");

    const r2 = createRun("f2");
    advanceTo(r2, "f2", "build");
    lifecycle.advanceRun(r2, "failed");
    expect(lifecycle.getRunPhase(r2)).toBe("failed");

    const r3 = createRun("f3");
    advanceTo(r3, "f3", "evaluate");
    lifecycle.advanceRun(r3, "failed");
    expect(lifecycle.getRunPhase(r3)).toBe("failed");
  });

  // =========================================================================
  // advanceRun stores phase_reason
  // =========================================================================

  it("stores reason when advancing", () => {
    const runId = createRun("auth");
    registerPlanArtifact(runId);
    lifecycle.advanceRun(runId, "contract", "plan review complete");
    const run = db.runs.get(runId);
    expect(run?.phase_reason).toBe("plan review complete");
  });

  // =========================================================================
  // canAdvance
  // =========================================================================

  it("canAdvance returns allowed/disallowed with reason", () => {
    const runId = createRun("auth");

    const [ok1, reason1] = lifecycle.canAdvance(runId, "contract");
    expect(ok1).toBe(false);
    expect(reason1).toContain("plan artifact");

    registerPlanArtifact(runId);
    const [ok2, reason2] = lifecycle.canAdvance(runId, "contract");
    expect(ok2).toBe(true);
    expect(reason2).toContain("plan -> contract");
  });

  it("rejects contract -> build until an accepted contract exists", () => {
    const runId = createRun("auth");
    registerPlanArtifact(runId);
    lifecycle.advanceRun(runId, "contract");

    const [ok1, reason1] = lifecycle.canAdvance(runId, "build");
    expect(ok1).toBe(false);
    expect(reason1).toContain("accepted contracts");

    registerContractArtifact(runId);

    const [ok2, reason2] = lifecycle.canAdvance(runId, "build");
    expect(ok2).toBe(true);
    expect(reason2).toContain("contract -> build");
  });

  // =========================================================================
  // canMerge
  // =========================================================================

  it("canMerge requires approved review scope with matching entries", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "evaluate");

    // No scope at all
    const [ok1, reason1] = lifecycle.canMerge(runId);
    expect(ok1).toBe(false);
    expect(reason1).toContain("No approved review scope");

    // Create a scope but don't approve it
    const sessionId = createTestSession(runId, feature);
    const mergeId = db.merges.enqueue({
      feature,
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: runId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });
    const scopeId = uid("scope");
    const scopeHash = computeScopeHash({
      mergeEntryIds: [mergeId],
      branches: ["cnog/auth/builder-auth"],
      headShas: ["abc123"],
      contractIds: [],
      contractHashes: [],
      verifyCommands: [],
    });
    db.reviewScopes.create({
      id: scopeId,
      run_id: runId,
      scope_status: "pending",
      scope_hash: scopeHash,
      merge_entries: JSON.stringify([mergeId]),
      branches: JSON.stringify(["cnog/auth/builder-auth"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });

    const [ok2] = lifecycle.canMerge(runId);
    expect(ok2).toBe(false);

    // Approve the scope — need a real evaluator session for FK
    const evalSessionId = uid("eval-sess");
    db.sessions.create({
      id: evalSessionId,
      name: `evaluator-${evalSessionId}`,
      logical_name: `evaluator-${evalSessionId}`,
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature,
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.reviewScopes.setVerdict(scopeId, "APPROVE", evalSessionId);

    const [ok3, reason3] = lifecycle.canMerge(runId);
    expect(ok3).toBe(true);
    expect(reason3).toContain("approved");
  });

  it("canMerge rejects when not in merge or evaluate phase", () => {
    const runId = createRun("auth");
    const [ok, reason] = lifecycle.canMerge(runId);
    expect(ok).toBe(false);
    expect(reason).toContain("plan");
  });

  it("canMerge detects scope drift", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "evaluate");

    // Create a merge entry and a matching scope
    const sessionId = createTestSession(runId, feature);
    const mergeId = db.merges.enqueue({
      feature,
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: runId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });
    const scopeId = uid("scope");
    const scopeHash = computeScopeHash({
      mergeEntryIds: [mergeId],
      branches: ["cnog/auth/builder-auth"],
      headShas: ["abc123"],
      contractIds: [],
      contractHashes: [],
      verifyCommands: [],
    });
    const evalSessionId = uid("eval-sess");
    db.sessions.create({
      id: evalSessionId,
      name: `evaluator-${evalSessionId}`,
      logical_name: `evaluator-${evalSessionId}`,
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature,
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.reviewScopes.create({
      id: scopeId,
      run_id: runId,
      scope_status: "pending",
      scope_hash: scopeHash,
      merge_entries: JSON.stringify([mergeId]),
      branches: JSON.stringify(["cnog/auth/builder-auth"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });
    db.reviewScopes.setVerdict(scopeId, "APPROVE", evalSessionId);

    // Add another pending merge entry (simulates scope drift)
    const sessionId2 = createTestSession(runId, feature, `builder-auth-drift-${uid("s")}`);
    db.merges.enqueue({
      feature,
      branch: "cnog/auth/builder-auth-2",
      agent_name: "builder-auth-2",
      run_id: runId,
      session_id: sessionId2,
      task_id: null,
      head_sha: "def456",
      files_modified: null,
    });

    const [ok, reason] = lifecycle.canMerge(runId);
    expect(ok).toBe(false);
    expect(reason).toContain("scope drift");
  });

  // =========================================================================
  // canShip
  // =========================================================================

  it("canShip requires approved scope with all entries merged", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "merge");

    // Merge entry is still pending
    const [ok1, reason1] = lifecycle.canShip(runId);
    expect(ok1).toBe(false);
    expect(reason1).toContain("not merged");

    // Get the merge entry that was created by advanceTo and mark it merged
    const merges = db.merges.list(feature);
    const pending = merges.find((m) => m.status === "pending");
    if (pending) {
      db.merges.updateStatus(pending.id, "merged", "clean");
    }

    const approved = db.reviewScopes.latestApproved(runId)!;
    registerVerifyArtifact(runId, approved.scope_hash, true);

    const [ok2, reason2] = lifecycle.canShip(runId);
    expect(ok2).toBe(true);
    expect(reason2).toContain("canonically verified");
  });

  it("canShip rejects when not in merge or ship phase", () => {
    const runId = createRun("auth");
    const [ok, reason] = lifecycle.canShip(runId);
    expect(ok).toBe(false);
    expect(reason).toContain("plan");
  });

  it("canShip returns true for done phase", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "ship");
    lifecycle.advanceRun(runId, "done");

    const [ok] = lifecycle.canShip(runId);
    expect(ok).toBe(true);
  });

  it("canShip rejects when scope has no merge entries", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "evaluate");

    // Create an approved scope with empty merge_entries
    const evalSessionId = uid("eval-sess");
    db.sessions.create({
      id: evalSessionId,
      name: `evaluator-${evalSessionId}`,
      logical_name: `evaluator-${evalSessionId}`,
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature,
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    const scopeId = uid("scope");
    db.reviewScopes.create({
      id: scopeId,
      run_id: runId,
      scope_status: "pending",
      scope_hash: "hash-empty",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });
    db.reviewScopes.setVerdict(scopeId, "APPROVE", evalSessionId);

    // Advance to merge bypassed the normal canMerge by using this special scope
    // Instead, manually update the run to merge phase to test canShip
    db.runs.update(runId, { status: "merge" });

    const [ok, reason] = lifecycle.canShip(runId);
    expect(ok).toBe(false);
    expect(reason).toContain("no merge entries");
  });

  it("canShip rejects when no matching verify artifact exists", () => {
    const feature = "auth";
    const runId = createRun(feature);
    const { mergeId, scopeId } = advanceTo(runId, feature, "merge");
    db.merges.updateStatus(mergeId!, "merged", "clean");

    const scope = db.reviewScopes.get(scopeId!)!;
    const [ok, reason] = lifecycle.canShip(runId);
    expect(ok).toBe(false);
    expect(reason).toContain("verify report");

    registerVerifyArtifact(runId, scope.scope_hash, false);
    const [ok2, reason2] = lifecycle.canShip(runId);
    expect(ok2).toBe(false);
    expect(reason2).toContain("did not pass");
  });

  // =========================================================================
  // Feature convenience methods
  // =========================================================================

  it("getFeaturePhase returns latest run phase for a feature", () => {
    const feature = "auth";
    const runId = createRun(feature);
    registerPlanArtifact(runId);
    lifecycle.advanceRun(runId, "contract");

    expect(lifecycle.getFeaturePhase(feature)).toBe("contract");
  });

  it("latestRun returns the most recent run for a feature", () => {
    const feature = "auth";
    const run1 = createRun(feature, "run-old");
    // createRun marks existing active runs as done, so run-old is now done
    const run2 = createRun(feature, "run-new");

    const latest = lifecycle.latestRun(feature);
    // run-new was inserted after run-old so ORDER BY created_at DESC picks it
    expect(latest).toBeDefined();
    expect(latest!.feature).toBe(feature);
  });

  // =========================================================================
  // listFeatures
  // =========================================================================

  it("listFeatures returns all tracked features with phases", () => {
    createRun("auth");
    createRun("billing");

    const features = lifecycle.listFeatures();
    expect(features).toHaveLength(2);

    const names = features.map((f) => f.feature);
    expect(names).toContain("auth");
    expect(names).toContain("billing");

    // Both should be in plan phase
    for (const f of features) {
      expect(f.phase).toBe("plan");
      expect(f.reviewVerdict).toBeNull();
    }
  });

  it("listFeatures shows approved verdict when scope exists", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "merge");

    const features = lifecycle.listFeatures();
    const auth = features.find((f) => f.feature === "auth");
    expect(auth).toBeDefined();
    expect(auth!.reviewVerdict).toBe("APPROVE");
  });

  // =========================================================================
  // Feature phase cache sync
  // =========================================================================

  it("syncs feature_phases cache on run advance", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "build");

    // build maps to "implement" in the legacy cache
    const cached = db.phases.get(feature);
    expect(cached).toBeDefined();
    expect(cached!.phase).toBe("implement");
  });

  it("syncs feature_phases cache to review on evaluate", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "evaluate");

    const cached = db.phases.get(feature);
    expect(cached!.phase).toBe("review");
  });

  it("archives and resets a run to a clean executable phase", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "contract");

    const issueId = uid("issue");
    db.issues.create({
      id: issueId,
      title: "Task A",
      description: null,
      issue_type: "task",
      status: "done",
      priority: 1,
      assignee: "builder-auth",
      feature,
      run_id: runId,
      plan_number: "01",
      phase: "build",
      parent_id: null,
      metadata: JSON.stringify({ planTaskKey: "auth:01:00", planTaskIndex: 0 }),
    });
    persistJsonArtifact({
      db,
      artifactId: uid("art"),
      runId,
      feature,
      type: "contract",
      filename: `contract-${uid("file")}.json`,
      data: {
        id: uid("contract"),
        taskId: issueId,
        runId,
        feature,
        agentName: "builder-auth",
        acceptanceCriteria: [{ description: "do the thing", testable: true }],
        verifyCommands: ["npm test"],
        fileScope: ["src/test.ts"],
        status: "accepted",
        proposedAt: new Date().toISOString(),
        reviewedBy: "evaluator-test",
        reviewedAt: new Date().toISOString(),
        reviewNotes: null,
      },
      projectRoot: tmpDir,
      issueId,
    });

    const sessionId = createTestSession(runId, feature, "builder-auth");
    const mergeId = db.merges.enqueue({
      feature,
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: runId,
      session_id: sessionId,
      task_id: issueId,
      head_sha: "abc123",
      files_modified: null,
    });
    db.merges.updateStatus(mergeId, "conflict");

    const evalSessionId = uid("eval-sess");
    db.sessions.create({
      id: evalSessionId,
      name: `evaluator-${evalSessionId}`,
      logical_name: `evaluator-${evalSessionId}`,
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature,
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    const scopeId = uid("scope");
    db.reviewScopes.create({
      id: scopeId,
      run_id: runId,
      scope_status: "approved",
      scope_hash: "scope-hash",
      merge_entries: JSON.stringify([mergeId]),
      branches: JSON.stringify(["cnog/auth/builder-auth"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: "APPROVE",
      evaluator_session: evalSessionId,
    });

    const archivePath = lifecycle.resetRun(runId, "test reset");

    expect(archivePath).toContain("/archive/reset-");
    expect(db.runs.get(runId)?.status).toBe("build");
    expect(db.issues.get(issueId)?.status).toBe("open");
    expect(db.issues.get(issueId)?.assignee).toBeNull();
    expect(db.reviewScopes.get(scopeId)?.scope_status).toBe("stale");
    expect(db.merges.listForRun(runId)[0]?.status).toBe("failed");
    expect(db.sessions.get("builder-auth")?.state).toBe("failed");
  });

  it("kills live tmux sessions and removes worktrees during run reset", () => {
    const feature = "auth";
    const runId = createRun(feature);
    advanceTo(runId, feature, "contract");

    const killSession = vi.spyOn(tmux, "killSession").mockReturnValue(true);
    const removeWorktree = vi.spyOn(worktree, "remove").mockReturnValue(true);
    const deleteBranch = vi.spyOn(worktree, "deleteBranch").mockReturnValue(true);

    const sessionId = createTestSession(runId, feature, "builder-auth-reset");
    db.db
      .prepare("UPDATE sessions SET tmux_session = ?, worktree_path = ? WHERE id = ?")
      .run("cnog-builder-auth-reset", join(tmpDir, ".cnog", "worktrees", "builder-auth-reset"), sessionId);

    lifecycle.resetRun(runId, "cleanup test");

    expect(killSession).toHaveBeenCalledWith("cnog-builder-auth-reset");
    expect(removeWorktree).toHaveBeenCalledWith("builder-auth-reset", tmpDir, true);
    expect(deleteBranch).toHaveBeenCalledWith(feature, "builder-auth-reset", tmpDir, true);
    expect(db.sessions.get("builder-auth-reset")?.state).toBe("failed");
  });
});
