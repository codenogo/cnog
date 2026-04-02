import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MailClient } from "../src/mail.js";
import { Watchdog } from "../src/watchdog.js";
import { buildStatusSnapshot } from "../src/status.js";
import { buildDoctorChecks } from "../src/doctor.js";
import type { CnogConfig } from "../src/config.js";

let db: CnogDB;
let events: EventEmitter;
let mail: MailClient;
let tmpDir: string;
let config: CnogConfig;
let testRunId: string;

function createTestRun(db: CnogDB, feature: string = "test-feature"): string {
  const id = `run-sd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return id;
}

function createTestSession(db: CnogDB, runId: string, name: string, feature: string): string {
  const id = `sess-${name}`;
  db.sessions.create({
    id, name, logical_name: name, attempt: 1, runtime: "claude", capability: "builder",
    feature, task_id: null, execution_task_id: null, worktree_path: null,
    transcript_path: `.cnog/features/${feature}/runs/${runId}/sessions/${name}.log`, branch: `cnog/${feature}/${name}`,
    tmux_session: `cnog-${name}`, pid: 123, state: "working", parent_agent: null, run_id: runId,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-status-doctor-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  mail = new MailClient(db);
  testRunId = createTestRun(db, "auth");
  config = {
    project: { name: "cnog", root: ".", canonicalBranch: "main" },
    agents: { runtime: "claude", maxConcurrent: 4, maxDepth: 2, staggerDelayMs: 2000, bootDelayMs: 2000 },
    orchestrator: { tickIntervalMs: 10_000, maxWip: 4 },
    watchdog: { staleThresholdMs: 60_000, zombieThresholdMs: 300_000 },
    verify: { commands: [] },
  };
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("status and doctor snapshots", () => {
  it("includes runtime, features, and health in the status snapshot", () => {
    const sessionId = createTestSession(db, testRunId, "builder-auth", "auth");
    db.db.prepare("UPDATE sessions SET started_at = ? WHERE name = ?").run("2026-03-26 12:00:00", "builder-auth");
    db.runs.update(testRunId, { status: "merge", profile: "feature-delivery" });
    db.sessions.create({
      id: "sess-eval-auth", name: "evaluator-auth", logical_name: "evaluator-auth", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: "auth", task_id: null, execution_task_id: null,
      worktree_path: null, transcript_path: null, branch: null, tmux_session: null, pid: null, state: "completed",
      parent_agent: null, run_id: testRunId,
    });
    db.issues.create({
      id: "issue-auth-1",
      title: "Implement auth builder flow",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-auth",
      feature: "auth",
      run_id: testRunId,
      plan_number: null,
      phase: "build",
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-auth-build",
      run_id: testRunId,
      issue_id: "issue-auth-1",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-auth-1",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: sessionId,
      summary: "Implementing auth builder flow",
      output_path: `.cnog/features/auth/runs/${testRunId}/tasks/xtask-auth-build.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.sessionProgress.recordActivity({
      sessionId,
      runId: testRunId,
      executionTaskId: "xtask-auth-build",
      transcriptPath: `.cnog/features/auth/runs/${testRunId}/sessions/builder-auth.log`,
      transcriptSize: 256,
      toolName: "Write",
      activityKind: "write",
      summary: "Modified src/auth.ts",
      target: "src/auth.ts",
      at: "2026-03-26 12:00:30",
    });
    db.reviewScopes.create({
      id: "scope-auth-approved",
      run_id: testRunId,
      scope_status: "approved",
      scope_hash: "scope-auth",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: "APPROVE",
      evaluator_session: "sess-eval-auth",
    });
    db.executionTasks.create({
      id: "xtask-auth-review",
      run_id: testRunId,
      issue_id: null,
      review_scope_id: "scope-auth-approved",
      parent_task_id: null,
      logical_name: "implementation_review:run-auth",
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Evaluation completed with verdict APPROVE",
      output_path: `.cnog/features/auth/runs/${testRunId}/tasks/xtask-auth-review.output`,
      result_path: `.cnog/features/auth/runs/${testRunId}/review-report.json`,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: testRunId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => new Date("2026-03-26T12:02:00.000Z").getTime(),
      },
    );

    const snapshot = buildStatusSnapshot(db, config, watchdog);
    expect(snapshot.summary.configuredRuntime).toBe("claude");
    expect(snapshot.agents[0].runtime).toBe("claude");
    expect(snapshot.agents[0].toolUseCount).toBe(1);
    expect(snapshot.agents[0].lastActivitySummary).toBe("Modified src/auth.ts");
    expect(snapshot.agents[0].transcriptPath).toBe(`.cnog/features/auth/runs/${testRunId}/sessions/builder-auth.log`);
    expect(snapshot.summary.activeTasks).toBe(1);
    expect(snapshot.summary.blockedTasks).toBe(0);
    expect(snapshot.summary.failedTasks).toBe(0);
    expect(snapshot.tasks[0]).toMatchObject({
      logicalName: "build:issue-auth-1",
      issueTitle: "Implement auth builder flow",
      status: "running",
      selectedSession: "builder-auth",
      selectedAttempt: 1,
      selectedReason: "active",
      transcriptPath: `.cnog/features/auth/runs/${testRunId}/sessions/builder-auth.log`,
      feature: "auth",
    });
    expect(snapshot.tasks[1]).toMatchObject({
      logicalName: "implementation_review:run-auth",
      status: "completed",
      outputPath: `.cnog/features/auth/runs/${testRunId}/tasks/xtask-auth-review.output`,
      resultPath: `.cnog/features/auth/runs/${testRunId}/review-report.json`,
    });
    expect(snapshot.features[0]).toMatchObject({
      feature: "auth",
      phase: "merge",
      reviewVerdict: "APPROVE",
      profile: "feature-delivery",
    });
    expect(snapshot.health[0].decision.kind).toBe("stale");
  });

  it("shows blocked tasks without counting them as active work", () => {
    db.runs.update(testRunId, { status: "evaluate" });
    db.executionTasks.create({
      id: "xtask-auth-blocked",
      run_id: testRunId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "implementation_review:auth",
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "blocked",
      active_session_id: null,
      summary: "Blocked: waiting on external dependency",
      output_path: `.cnog/features/auth/runs/${testRunId}/tasks/xtask-auth-blocked.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: "external_blocker",
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => Date.now(),
      },
    );

    const snapshot = buildStatusSnapshot(db, config, watchdog);
    expect(snapshot.summary.activeTasks).toBe(0);
    expect(snapshot.summary.blockedTasks).toBe(1);
    expect(snapshot.tasks[0]).toMatchObject({
      logicalName: "implementation_review:auth",
      status: "blocked",
      lastError: "external_blocker",
    });
  });

  it("shows the active review scope status instead of an older historical verdict", () => {
    db.runs.update(testRunId, { status: "evaluate" });
    db.sessions.create({
      id: "sess-eval-auth-old", name: "evaluator-auth-old", logical_name: "evaluator-auth-old",
      attempt: 1, runtime: "claude", capability: "evaluator", feature: "auth", task_id: null, execution_task_id: null,
      worktree_path: null, transcript_path: null, branch: null, tmux_session: null, pid: null, state: "working",
      parent_agent: null, run_id: testRunId,
    });
    db.reviewScopes.create({
      id: "scope-auth-approved-old",
      run_id: testRunId,
      scope_status: "approved",
      scope_hash: "scope-auth-old",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: "APPROVE",
      evaluator_session: "sess-eval-auth-old",
    });
    db.reviewScopes.create({
      id: "scope-auth-pending-new",
      run_id: testRunId,
      scope_status: "pending",
      scope_hash: "scope-auth-new",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => Date.now(),
      },
    );

    const snapshot = buildStatusSnapshot(db, config, watchdog);
    expect(snapshot.features[0]).toMatchObject({
      feature: "auth",
      phase: "evaluate",
      reviewVerdict: null,
    });
  });

  it("doctor flags runtime config and merge conflicts", () => {
    const sessionId = createTestSession(db, testRunId, "builder-auth-doc", "auth");
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: testRunId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });
    const merge = db.merges.list()[0];
    db.merges.updateStatus(merge.id, "conflict");

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => Date.now(),
      },
    );

    const checks = buildDoctorChecks({
      projectRoot: tmpDir,
      initialized: true,
      config: { ...config, agents: { ...config.agents, runtime: "missing-runtime" } },
      db,
      watchdog,
    });

    expect(checks.find((check) => check.name === "configured runtime")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "merge conflicts")?.ok).toBe(false);
  });
});
