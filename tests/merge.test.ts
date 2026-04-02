import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { CnogError } from "../src/errors.js";
import { Lifecycle } from "../src/lifecycle.js";
import { MergeQueue } from "../src/merge.js";
import { computeScopeHash } from "../src/review.js";

let db: CnogDB;
let events: EventEmitter;
let tmpDir: string;
let testRunId: string;
let sessionSeq = 0;

function createTestRun(db: CnogDB, feature: string = "test-feature"): string {
  const id = `run-merge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return id;
}

function createTestSession(db: CnogDB, runId: string, feature: string): string {
  const id = `sess-merge-${++sessionSeq}`;
  const name = `builder-merge-${sessionSeq}`;
  db.sessions.create({
    id, name, logical_name: name, attempt: 1, runtime: "claude", capability: "builder",
    feature, task_id: null, execution_task_id: null, worktree_path: null, transcript_path: null, branch: null, tmux_session: null,
    pid: null, state: "working", parent_agent: null, run_id: runId,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-merge-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  sessionSeq = 0;
  testRunId = createTestRun(db, "auth");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MergeQueue", () => {
  it("enqueues a merge entry", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const sessionId = createTestSession(db, testRunId, "auth");
    const id = queue.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-1",
      agentName: "builder-1",
      runId: testRunId,
      sessionId,
      headSha: "abc123",
      filesModified: ["src/auth.ts"],
    });

    expect(id).toBeGreaterThan(0);
    const pending = queue.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].branch).toBe("cnog/auth/builder-1");
    expect(db.executionTasks.getByLogicalName(testRunId, `merge:${id}`)).toMatchObject({
      kind: "merge",
      capability: "system",
      status: "pending",
      summary: "Pending merge for cnog/auth/builder-1",
    });
  });

  it("anchors issue-backed merge tasks to the canonical build task", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const issueId = "issue-merge-parent";
    db.issues.create({
      id: issueId,
      title: "Implement merge parent",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-merge-1",
      feature: "auth",
      run_id: testRunId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-build-parent",
      run_id: testRunId,
      issue_id: issueId,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issueId}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Build completed",
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    const sessionId = createTestSession(db, testRunId, "auth");
    const id = queue.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-parent",
      agentName: "builder-parent",
      runId: testRunId,
      sessionId,
      taskId: issueId,
      headSha: "abc123",
      filesModified: ["src/auth.ts"],
    });

    expect(db.executionTasks.getByLogicalName(testRunId, `merge:${id}`)).toMatchObject({
      parent_task_id: "xtask-build-parent",
      issue_id: issueId,
    });
  });

  it("repairs existing merge tasks by restoring both issue linkage and parent lineage", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const issueId = "issue-merge-repair";
    db.issues.create({
      id: issueId,
      title: "Repair merge lineage",
      description: null,
      issue_type: "task",
      status: "done",
      priority: 1,
      assignee: null,
      feature: "auth",
      run_id: testRunId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-build-repair-parent",
      run_id: testRunId,
      issue_id: issueId,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issueId}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Build completed",
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-wrong-parent",
      run_id: testRunId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:wrong-parent",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "failed",
      active_session_id: null,
      summary: "Stale parent task",
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:01:00",
      last_error: "stale",
    });

    const sessionId = createTestSession(db, testRunId, "auth");
    const mergeId = db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-repair",
      agent_name: "builder-repair",
      run_id: testRunId,
      session_id: sessionId,
      task_id: issueId,
      head_sha: "abc123",
      files_modified: null,
    });

    db.executionTasks.create({
      id: `xtask-merge-${mergeId}`,
      run_id: testRunId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: "xtask-wrong-parent",
      logical_name: `merge:${mergeId}`,
      kind: "merge",
      capability: "system",
      executor: "system",
      status: "pending",
      active_session_id: null,
      summary: "Pending merge for cnog/auth/builder-repair",
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    queue.processNext();

    expect(db.executionTasks.getByLogicalName(testRunId, `merge:${mergeId}`)).toMatchObject({
      issue_id: issueId,
      parent_task_id: "xtask-build-repair-parent",
    });
  });

  it("rejects issue-backed merge enqueue when the canonical build task is missing", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const issueId = "issue-missing-parent";
    db.issues.create({
      id: issueId,
      title: "Missing build task",
      description: null,
      issue_type: "task",
      status: "done",
      priority: 1,
      assignee: null,
      feature: "auth",
      run_id: testRunId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });

    const sessionId = createTestSession(db, testRunId, "auth");

    expect(() => queue.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-missing-parent",
      agentName: "builder-missing-parent",
      runId: testRunId,
      sessionId,
      taskId: issueId,
      headSha: "abc123",
    })).toThrowError(CnogError);
    expect(db.merges.listForRun(testRunId)).toHaveLength(0);
  });

  it("pending() filters by feature", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const billingRunId = createTestRun(db, "billing");
    const s1 = createTestSession(db, testRunId, "auth");
    const s2 = createTestSession(db, billingRunId, "billing");
    queue.enqueue({ feature: "auth", branch: "b1", agentName: "a1", runId: testRunId, sessionId: s1, headSha: "sha1" });
    queue.enqueue({ feature: "billing", branch: "b2", agentName: "a2", runId: billingRunId, sessionId: s2, headSha: "sha2" });

    expect(queue.pending("auth")).toHaveLength(1);
    expect(queue.pending("billing")).toHaveLength(1);
    expect(queue.pending()).toHaveLength(2);
  });

  it("processNext returns null when queue is empty", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    expect(queue.processNext()).toBeNull();
  });

  it("processAll returns empty array when queue is empty", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    expect(queue.processAll()).toEqual([]);
  });

  it("processNext attempts merge and returns result", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const sessionId = createTestSession(db, testRunId, "auth");
    queue.enqueue({ feature: "auth", branch: "cnog/auth/builder-1", agentName: "builder-1", runId: testRunId, sessionId, headSha: "abc123" });

    // No real git repo, so merge will fail — that's expected
    const result = queue.processNext();
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    // Should have attempted and failed (no git repo)
  });

  it("lifecycle gating blocks merge when not approved", () => {
    const lifecycle = new Lifecycle(db, events, tmpDir);
    // Run is in "plan" phase — merge should be blocked
    const queue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    const sessionId = createTestSession(db, testRunId, "auth");
    queue.enqueue({ feature: "auth", branch: "b1", agentName: "a1", runId: testRunId, sessionId, headSha: "abc" });

    const result = queue.processNext();
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.message).toContain("blocked");
    expect(db.executionTasks.getByLogicalName(testRunId, "merge:1")?.status).toBe("pending");
  });

  it("enqueue logs merge event", () => {
    const queue = new MergeQueue(db, events, "main", tmpDir);
    const sessionId = createTestSession(db, testRunId, "auth");
    queue.enqueue({ feature: "auth", branch: "b1", agentName: "a1", runId: testRunId, sessionId, headSha: "abc" });

    const eventRows = db.events.query({ source: "merge" });
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].event_type).toBe("merge_enqueued");
  });

  it("reopens the issue and moves the run back to build on merge conflict", () => {
    const lifecycle = new Lifecycle(db, events, tmpDir);
    db.runs.update(testRunId, { status: "merge" });

    const issueId = "cn-merge-rework";
    db.issues.create({
      id: issueId,
      title: "Resolve merge conflict",
      description: null,
      issue_type: "task",
      status: "done",
      priority: 1,
      assignee: "builder-merge-1",
      feature: "auth",
      run_id: testRunId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-build-conflict",
      run_id: testRunId,
      issue_id: issueId,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issueId}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Build completed",
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    const sessionId = createTestSession(db, testRunId, "auth");
    const mergeId = db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-conflict",
      agent_name: "builder-conflict",
      run_id: testRunId,
      session_id: sessionId,
      task_id: issueId,
      head_sha: "abc123",
      files_modified: null,
    });
    const scopeId = "scope-merge-conflict";
    const evalSessionId = `sess-eval-conflict-${++sessionSeq}`;
    db.sessions.create({
      id: evalSessionId, name: `evaluator-conflict-${sessionSeq}`, logical_name: `evaluator-conflict-${sessionSeq}`,
      attempt: 1, runtime: "claude", capability: "evaluator", feature: "auth", task_id: null, execution_task_id: null,
      worktree_path: null, transcript_path: null, branch: null, tmux_session: null, pid: null, state: "working",
      parent_agent: null, run_id: testRunId,
    });
    db.reviewScopes.create({
      id: scopeId,
      run_id: testRunId,
      scope_status: "pending",
      scope_hash: computeScopeHash({
        mergeEntryIds: [mergeId],
        branches: ["cnog/auth/builder-conflict"],
        headShas: ["abc123"],
        contractIds: [],
        contractHashes: [],
        verifyCommands: [],
      }),
      merge_entries: JSON.stringify([mergeId]),
      branches: JSON.stringify(["cnog/auth/builder-conflict"]),
      head_shas: JSON.stringify(["abc123"]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });
    db.reviewScopes.setVerdict(scopeId, "APPROVE", evalSessionId);

    const queue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    const result = queue.processNext();
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);

    expect(db.issues.get(issueId)?.status).toBe("open");
    expect(db.runs.get(testRunId)?.status).toBe("build");
    expect(db.reviewScopes.get(scopeId)?.scope_status).toBe("stale");
    expect(db.executionTasks.getByLogicalName(testRunId, `merge:${mergeId}`)?.status).toBe("failed");

    const mergeArtifacts = db.artifacts.listByRun(testRunId, "merge-record");
    expect(mergeArtifacts).toHaveLength(1);
  });
});
