import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import {
  requestCanonicalVerification,
  requestIssueVerification,
  requestReviewScopeVerification,
  reconcileVerificationTasks,
} from "../src/verify.js";

let db: CnogDB;
let tmpDir: string;

function createRun(feature: string = "auth"): string {
  const runId = `run-verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id: runId,
    feature,
    plan_number: null,
    status: "merge",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  return runId;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-verify-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function settleVerification(runId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const outcomes = reconcileVerificationTasks({
      db,
      runId,
      projectRoot: tmpDir,
    });
    if (outcomes.length > 0) {
      return outcomes[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Verification did not settle for run ${runId}`);
}

describe("requestCanonicalVerification", () => {
  it("creates shell-backed verify tasks and a passing verify artifact", async () => {
    const runId = createRun("auth");
    db.reviewScopes.create({
      id: "scope-verify-pass",
      run_id: runId,
      scope_status: "approved",
      scope_hash: "scope-hash-pass",
      merge_entries: JSON.stringify([1]),
      branches: JSON.stringify(["main"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify(["npm test", "npm run lint"]),
      verdict: "APPROVE",
      evaluator_session: null,
    });

    const initial = requestCanonicalVerification({
      db,
      runId,
      feature: "auth",
      scopeId: "scope-verify-pass",
      scopeHash: "scope-hash-pass",
      canonicalBranch: "main",
      commands: ['node -e "console.log(\'ok:test\')"', 'node -e "console.log(\'ok:lint\')"'],
      projectRoot: tmpDir,
    });
    expect(["scheduled", "running", "passed"]).toContain(initial.status);
    const verification = await settleVerification(runId);

    expect(verification.passed).toBe(true);
    expect(verification.results).toHaveLength(2);
    expect(db.executionTasks.getByLogicalName(runId, "verify:canonical-scope-verify-pass:00")).toMatchObject({
      kind: "verify",
      capability: "shell",
      status: "completed",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-verify-canonical-scope-verify-pass-00.output`,
      result_path: verification.artifact.path,
    });
    expect(db.executionTasks.getByLogicalName(runId, "verify:canonical-scope-verify-pass:01")).toMatchObject({
      status: "completed",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-verify-canonical-scope-verify-pass-01.output`,
      result_path: verification.artifact.path,
    });
    expect(db.artifacts.listByRun(runId, "verify-report")).toHaveLength(1);
  });

  it("marks failed verify commands as failed tasks and persists the failing report", async () => {
    const runId = createRun("billing");
    db.reviewScopes.create({
      id: "scope-verify-fail",
      run_id: runId,
      scope_status: "approved",
      scope_hash: "scope-hash-fail",
      merge_entries: JSON.stringify([1]),
      branches: JSON.stringify(["main"]),
      head_shas: JSON.stringify(["def456"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify(["npm test"]),
      verdict: "APPROVE",
      evaluator_session: null,
    });

    requestCanonicalVerification({
      db,
      runId,
      feature: "billing",
      scopeId: "scope-verify-fail",
      scopeHash: "scope-hash-fail",
      canonicalBranch: "main",
      commands: ['node -e "process.stderr.write(\'tests failed\'); process.exit(2)"'],
      projectRoot: tmpDir,
    });
    const verification = await settleVerification(runId);

    expect(verification.passed).toBe(false);
    expect(db.executionTasks.getByLogicalName(runId, "verify:canonical-scope-verify-fail:00")).toMatchObject({
      status: "failed",
      last_error: "Exit 2: tests failed",
      output_path: `.cnog/features/billing/runs/${runId}/tasks/xtask-verify-canonical-scope-verify-fail-00.output`,
      result_path: verification.artifact.path,
    });

    const artifact = db.artifacts.listByRun(runId, "verify-report")[0];
    expect(artifact.review_scope_id).toBe("scope-verify-fail");
  });

  it("creates a distinct canonical batch when review-scope verification already used the same scope id", async () => {
    const runId = createRun("auth");
    db.reviewScopes.create({
      id: "scope-collision",
      run_id: runId,
      scope_status: "approved",
      scope_hash: "scope-hash-collision",
      merge_entries: JSON.stringify([1]),
      branches: JSON.stringify(["cnog/auth/builder-auth"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify(["npm test"]),
      verdict: "APPROVE",
      evaluator_session: null,
    });
    db.executionTasks.create({
      id: "xtask-review-collision",
      run_id: runId,
      issue_id: null,
      review_scope_id: "scope-collision",
      parent_task_id: null,
      logical_name: `implementation_review:${runId}`,
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Completed evaluation",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-review-collision.output`,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-verify-scope-collision-00",
      run_id: runId,
      issue_id: null,
      review_scope_id: "scope-collision",
      parent_task_id: "xtask-review-collision",
      logical_name: "verify:scope-collision:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Scope verify passed",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-verify-scope-collision-00.output`,
      result_path: ".cnog/features/auth/runs/run-scope/verify-report.json",
      command: 'node -e "console.log(\'scope\')"',
      cwd: tmpDir,
      process_id: null,
      exit_code: 0,
      output_size: 6,
      last_output_at: "2026-04-01 10:00:00",
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    const verification = requestCanonicalVerification({
      db,
      runId,
      feature: "auth",
      scopeId: "scope-collision",
      scopeHash: "scope-hash-collision",
      canonicalBranch: "main",
      commands: ['node -e "console.log(\'canonical\')"'],
      projectRoot: tmpDir,
    });
    expect(["scheduled", "running", "passed"]).toContain(verification.status);

    const settled = await settleVerification(runId);
    expect(settled.passed).toBe(true);
    expect(db.executionTasks.getByLogicalName(runId, "verify:canonical-scope-collision:00")).toMatchObject({
      review_scope_id: "scope-collision",
      parent_task_id: null,
      status: "completed",
    });
    expect(db.executionTasks.getByLogicalName(runId, "verify:scope-collision:00")).toMatchObject({
      parent_task_id: "xtask-review-collision",
      status: "completed",
    });
  });
});

describe("requestIssueVerification", () => {
  it("creates issue-scoped verify tasks in the builder worktree", async () => {
    const runId = createRun("ledger");
    db.executionTasks.create({
      id: "xtask-build-ledger",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-ledger-verify",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Completed builder",
      output_path: `.cnog/features/ledger/runs/${runId}/tasks/xtask-build-ledger.output`,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });
    db.issues.create({
      id: "issue-ledger-verify",
      title: "Implement ledger posting",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-ledger",
      feature: "ledger",
      run_id: runId,
      plan_number: null,
      phase: "build",
      parent_id: null,
      metadata: null,
    });

    requestIssueVerification({
      db,
      runId,
      feature: "ledger",
      issueId: "issue-ledger-verify",
      parentTaskId: "xtask-build-ledger",
      branch: "cnog/ledger/builder-ledger",
      worktreePath: tmpDir,
      commands: ['node -e "console.log(\'ok:test\')"'],
      projectRoot: tmpDir,
    });
    const verification = await settleVerification(runId);

    expect(verification.passed).toBe(true);
    expect(db.executionTasks.getByLogicalName(runId, "verify:issue-ledger-verify:00")).toMatchObject({
      issue_id: "issue-ledger-verify",
      review_scope_id: null,
      parent_task_id: "xtask-build-ledger",
      status: "completed",
      output_path: `.cnog/features/ledger/runs/${runId}/tasks/xtask-verify-issue-ledger-verify-00.output`,
      result_path: verification.artifact.path,
    });
    expect(db.artifacts.listByRun(runId, "verify-report")[0]?.issue_id).toBe("issue-ledger-verify");
  });

  it("finalizes an already completed verify batch instead of reopening it on a repeat request", () => {
    const runId = createRun("ledger");
    db.issues.create({
      id: "issue-ledger-repeat",
      title: "Implement ledger posting",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-ledger",
      feature: "ledger",
      run_id: runId,
      plan_number: null,
      phase: "build",
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-build-ledger-repeat",
      run_id: runId,
      issue_id: "issue-ledger-repeat",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-ledger-repeat",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Completed builder",
      output_path: `.cnog/features/ledger/runs/${runId}/tasks/xtask-build-ledger-repeat.output`,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-verify-issue-ledger-repeat-00",
      run_id: runId,
      issue_id: "issue-ledger-repeat",
      review_scope_id: null,
      parent_task_id: "xtask-build-ledger-repeat",
      logical_name: "verify:issue-ledger-repeat:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Verify passed: node -e \"console.log('ok:test')\"",
      output_path: `.cnog/features/ledger/runs/${runId}/tasks/xtask-verify-issue-ledger-repeat-00.output`,
      result_path: null,
      command: 'node -e "console.log(\'ok:test\')"',
      cwd: tmpDir,
      process_id: null,
      exit_code: 0,
      output_size: 8,
      last_output_at: "2026-04-01 10:00:00",
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    const outputPath = join(tmpDir, ".cnog", "features", "ledger", "runs", runId, "tasks", "xtask-verify-issue-ledger-repeat-00.output");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, "ok:test\n", "utf-8");

    const verification = requestIssueVerification({
      db,
      runId,
      feature: "ledger",
      issueId: "issue-ledger-repeat",
      parentTaskId: "xtask-build-ledger-repeat",
      branch: "cnog/ledger/builder-ledger",
      worktreePath: tmpDir,
      commands: ['node -e "console.log(\'ok:test\')"'],
      projectRoot: tmpDir,
    });

    expect(verification.status).toBe("passed");
    expect(db.executionTasks.getByLogicalName(runId, "verify:issue-ledger-repeat:00")).toMatchObject({
      status: "completed",
      result_path: verification.artifact?.path,
    });
    expect(db.artifacts.listByRun(runId, "verify-report")).toHaveLength(1);
  });
});

describe("requestReviewScopeVerification", () => {
  it("records failed review-scope verify tasks when the scope worktree cannot be prepared", () => {
    const runId = createRun("payments");
    db.executionTasks.create({
      id: "xtask-evaluate-payments",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `implementation_review:${runId}`,
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Evaluator running",
      output_path: `.cnog/features/payments/runs/${runId}/tasks/xtask-evaluate-payments.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.reviewScopes.create({
      id: "scope-review-verify",
      run_id: runId,
      scope_status: "pending",
      scope_hash: "scope-hash-review",
      merge_entries: JSON.stringify([1]),
      branches: JSON.stringify(["cnog/payments/builder-payments"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify(["npm test"]),
      verdict: null,
      evaluator_session: null,
    });

    const verification = requestReviewScopeVerification({
      db,
      runId,
      feature: "payments",
      scopeId: "scope-review-verify",
      parentTaskId: "xtask-evaluate-payments",
      scopeHash: "scope-hash-review",
      canonicalBranch: "main",
      branches: ["cnog/payments/builder-payments"],
      commands: ["npm test"],
      projectRoot: tmpDir,
    });

    expect(verification.status).toBe("failed");
    expect(db.executionTasks.getByLogicalName(runId, "verify:scope-review-verify:00")).toMatchObject({
      review_scope_id: "scope-review-verify",
      parent_task_id: "xtask-evaluate-payments",
      status: "failed",
    });
    const report = db.artifacts.listByRun(runId, "verify-report")[0];
    expect(report.review_scope_id).toBe("scope-review-verify");
  });
});
