import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import * as worktree from "../src/worktree.js";
import {
  appendExecutionTaskOutput,
  collectPendingTaskNotifications,
  ensureExecutionTaskOutput,
  markExecutionTaskNotified,
  resetExecutionTaskNotification,
  supersedeExecutionTaskDescendants,
} from "../src/task-runtime.js";

let db: CnogDB;
let tmpDir: string;

function createRun(feature: string = "auth"): string {
  const runId = `run-task-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id: runId,
    feature,
    plan_number: null,
    status: "build",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  return runId;
}

function createExecutionTask(runId: string, id: string, feature: string = "auth"): string {
  db.executionTasks.create({
    id,
    run_id: runId,
    issue_id: null,
    review_scope_id: null,
    parent_task_id: null,
    logical_name: `build:${feature}`,
    kind: "build",
    capability: "builder",
    executor: "agent",
    status: "pending",
    active_session_id: null,
    summary: "Ready",
    output_path: null,
    result_path: null,
    output_offset: 0,
    notified: 0,
    notified_at: null,
    last_error: null,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-task-runtime-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("task runtime output and notification lifecycle", () => {
  it("clears prior attempt output when a task is reset", () => {
    const runId = createRun();
    const taskId = createExecutionTask(runId, "xtask-retry");
    const outputPath = ensureExecutionTaskOutput(db, taskId, tmpDir);

    appendFileSync(outputPath, "old attempt output\n", "utf-8");
    resetExecutionTaskNotification(db, taskId, tmpDir);
    expect(readFileSync(outputPath, "utf-8")).toBe("");
    expect(db.executionTasks.get(taskId)?.output_offset).toBe(0);
    appendExecutionTaskOutput(db, taskId, "new attempt output\n", tmpDir);
    db.executionTasks.update(taskId, {
      status: "completed",
      summary: "Completed retry",
    });

    const notifications = collectPendingTaskNotifications(db, tmpDir, runId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].output).toContain("new attempt output");
    expect(notifications[0].output).not.toContain("old attempt output");
  });

  it("reads only the new tail of a large task log for terminal notifications", () => {
    const runId = createRun();
    const taskId = createExecutionTask(runId, "xtask-large");
    const outputPath = ensureExecutionTaskOutput(db, taskId, tmpDir);

    appendFileSync(outputPath, "old history should not appear\n", "utf-8");
    resetExecutionTaskNotification(db, taskId, tmpDir);
    expect(readFileSync(outputPath, "utf-8")).toBe("");
    appendExecutionTaskOutput(db, taskId, `${"x".repeat(40_000)}TAIL`, tmpDir);
    db.executionTasks.update(taskId, {
      status: "failed",
      summary: "Large failure",
      last_error: "boom",
    });

    const notifications = collectPendingTaskNotifications(db, tmpDir, runId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].output).toContain("[Truncated. Full output:");
    expect(notifications[0].output).toContain("TAIL");
    expect(notifications[0].output).not.toContain("old history should not appear");
  });

  it("marks the current task log size as notified offset", () => {
    const runId = createRun();
    const taskId = createExecutionTask(runId, "xtask-offset");
    const outputPath = ensureExecutionTaskOutput(db, taskId, tmpDir);

    appendExecutionTaskOutput(db, taskId, "offset check\n", tmpDir);
    db.executionTasks.update(taskId, {
      status: "completed",
      summary: "Done",
    });
    markExecutionTaskNotified(db, taskId, tmpDir);

    expect(db.executionTasks.get(taskId)?.output_offset).toBe(statSync(outputPath).size);
    expect(db.executionTasks.get(taskId)?.notified).toBe(1);
  });

  it("supersedes descendant work and emits only the supersession tail", () => {
    const runId = createRun();
    const parentTaskId = createExecutionTask(runId, "xtask-parent");
    db.executionTasks.create({
      id: "xtask-child",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: parentTaskId,
      logical_name: "verify:auth:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Verify passed",
      output_path: null,
      result_path: ".cnog/features/auth/runs/run-task-runtime/result.json",
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    appendExecutionTaskOutput(db, "xtask-child", "old verify output\n", tmpDir);
    const superseded = supersedeExecutionTaskDescendants(
      db,
      parentTaskId,
      "build:auth reopened for another attempt",
      tmpDir,
    );

    expect(superseded.map((task) => task.id)).toEqual(["xtask-child"]);
    expect(db.executionTasks.get("xtask-child")).toMatchObject({
      status: "superseded",
      notified: 0,
      summary: "Superseded: build:auth reopened for another attempt",
    });

    const notifications = collectPendingTaskNotifications(db, tmpDir, runId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].task.status).toBe("superseded");
    expect(notifications[0].output).toContain("[superseded] build:auth reopened for another attempt");
    expect(notifications[0].output).not.toContain("old verify output");
  });

  it("removes review-scope verifier worktrees when superseding descendant verify tasks", () => {
    const runId = createRun();
    const parentTaskId = createExecutionTask(runId, "xtask-parent-review");
    const removeWorktree = vi.spyOn(worktree, "remove").mockReturnValue(true);
    const deleteBranch = vi.spyOn(worktree, "deleteBranch").mockReturnValue(true);

    db.reviewScopes.create({
      id: "scope-supersede",
      run_id: runId,
      scope_status: "pending",
      scope_hash: "scope-hash-supersede",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify(["cnog/auth/builder-auth"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify(["npm test"]),
      verdict: null,
      evaluator_session: null,
    });

    db.executionTasks.create({
      id: "xtask-child-review-scope",
      run_id: runId,
      issue_id: null,
      review_scope_id: "scope-supersede",
      parent_task_id: parentTaskId,
      logical_name: "verify:scope-supersede:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "running",
      active_session_id: null,
      summary: "Running verify command: npm test",
      output_path: null,
      result_path: null,
      command: "npm test",
      cwd: join(tmpDir, ".cnog", "worktrees", "verify-scope-scope-supersede"),
      process_id: null,
      exit_code: null,
      output_size: 0,
      last_output_at: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    supersedeExecutionTaskDescendants(
      db,
      parentTaskId,
      "implementation_review reopened for another attempt",
      tmpDir,
    );

    expect(removeWorktree).toHaveBeenCalledWith("verify-scope-scope-supersede", tmpDir, true);
    expect(deleteBranch).toHaveBeenCalledWith("auth", "verify-scope-scope-supersede", tmpDir, true);
  });
});
