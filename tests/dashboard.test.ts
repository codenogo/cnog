import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { buildDisplay } from "../src/dashboard.js";

let db: CnogDB;
let tmpDir: string;

function createRun(feature: string, status: string = "build"): string {
  const id = `run-dashboard-${feature}`;
  db.runs.create({
    id,
    feature,
    plan_number: null,
    status,
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-dashboard-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("dashboard", () => {
  it("shows execution tasks alongside agent and merge information", () => {
    const runId = createRun("auth", "build");

    db.issues.create({
      id: "issue-auth-dashboard",
      title: "Implement auth endpoints",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-auth",
      feature: "auth",
      run_id: runId,
      plan_number: null,
      phase: "build",
      parent_id: null,
      metadata: null,
    });

    db.executionTasks.create({
      id: "xtask-auth-dashboard",
      run_id: runId,
      issue_id: "issue-auth-dashboard",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-auth-dashboard",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Implementing auth endpoints",
      output_path: ".cnog/features/auth/runs/run-dashboard-auth/tasks/xtask-auth-dashboard.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-auth-verify",
      run_id: runId,
      issue_id: "issue-auth-dashboard",
      review_scope_id: null,
      parent_task_id: "xtask-auth-dashboard",
      logical_name: "verify:issue-auth-dashboard:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Verify passed: npm test",
      output_path: ".cnog/features/auth/runs/run-dashboard-auth/tasks/xtask-auth-verify.output",
      result_path: ".cnog/features/auth/runs/run-dashboard-auth/verify-report-auth.json",
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-auth-blocked",
      run_id: runId,
      issue_id: "issue-auth-dashboard",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "implementation_review:auth",
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "blocked",
      active_session_id: null,
      summary: "Blocked: waiting on review input",
      output_path: ".cnog/features/auth/runs/run-dashboard-auth/tasks/xtask-auth-blocked.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: "need_clarification",
    });

    db.sessions.create({
      id: "sess-builder-auth-dashboard",
      name: "builder-auth-dashboard",
      logical_name: "builder-auth-dashboard",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: "issue-auth-dashboard",
      execution_task_id: "xtask-auth-dashboard",
      worktree_path: null,
      transcript_path: ".cnog/features/auth/runs/run-dashboard-auth/sessions/builder-auth-dashboard.log",
      branch: "cnog/auth/builder-auth-dashboard",
      tmux_session: "cnog-builder-auth-dashboard",
      pid: 123,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.sessionProgress.recordActivity({
      sessionId: "sess-builder-auth-dashboard",
      runId,
      executionTaskId: "xtask-auth-dashboard",
      transcriptPath: ".cnog/features/auth/runs/run-dashboard-auth/sessions/builder-auth-dashboard.log",
      transcriptSize: 512,
      toolName: "Write",
      activityKind: "write",
      summary: "Modified src/auth.ts",
      target: "src/auth.ts",
    });

    db.executionTasks.update("xtask-auth-dashboard", { active_session_id: "sess-builder-auth-dashboard" });

    const display = buildDisplay(db);

    expect(display).toContain("AGENTS");
    expect(display).toContain("TASKS");
    expect(display).toContain("Modified src/auth.ts");
    expect(display).toContain("build:issue-auth-dashboard");
    expect(display).toContain("builder-auth-dashboard#1 (active)");
    expect(display).toContain("verify:issue-auth-dashboard:00");
    expect(display).toContain("implementation_review:auth");
    expect(display).toContain("Blocked tasks: 1");
    expect(display).toContain("log: .cnog/features/auth/runs/run-dashboard-auth/tasks/xtask-auth-verify.output");
    expect(display).toContain("result: .cnog/features/auth/runs/run-dashboard-auth/verify-report-auth.json");
    expect(display).toContain("transcript: .cnog/features/auth/runs/run-dashboard-auth/sessions/builder-auth-dashboard.log");
    expect(display).toContain("Active tasks: 1");
  });
});
