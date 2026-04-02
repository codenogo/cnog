import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

import { CnogDB } from "../src/db.js";

let db: CnogDB;
let tmpDir: string;
let runSeq = 0;

function createTestRun(db: CnogDB, feature: string = "test-feature", id?: string): string {
  const runId = id ?? `run-test-${++runSeq}`;
  db.runs.create({
    id: runId, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return runId;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-db-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  runSeq = 0;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("sessions", () => {
  it("creates and retrieves a session", () => {
    const runId = createTestRun(db, "auth");
    db.sessions.create({
      id: "s1",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: "/tmp/wt",
      transcript_path: null,
      branch: "cnog/auth/builder-auth",
      tmux_session: "cnog-builder-auth",
      pid: 1234,
      state: "booting",
      parent_agent: null,
      run_id: runId,
    });

    const session = db.sessions.get("builder-auth");
    expect(session).toBeDefined();
    expect(session!.name).toBe("builder-auth");
    expect(session!.logical_name).toBe("builder-auth");
    expect(session!.attempt).toBe(1);
    expect(session!.runtime).toBe("claude");
    expect(session!.capability).toBe("builder");
    expect(session!.state).toBe("booting");
    expect(session!.pid).toBe(1234);
  });

  it("returns the latest attempt for a logical agent", () => {
    const runId = createTestRun(db, "auth");
    db.sessions.create({
      id: "s1",
      name: "evaluator-auth",
      logical_name: "evaluator-auth",
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/evaluator-auth",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.sessions.create({
      id: "s2",
      name: "evaluator-auth-r2",
      logical_name: "evaluator-auth",
      attempt: 2,
      runtime: "claude",
      capability: "evaluator",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/evaluator-auth-r2",
      tmux_session: null,
      pid: null,
      state: "failed",
      parent_agent: null,
      run_id: runId,
    });

    const latest = db.sessions.getLatestByLogicalName("evaluator-auth");
    expect(latest?.name).toBe("evaluator-auth-r2");
    expect(latest?.attempt).toBe(2);
  });

  it("updates session state", () => {
    const runId = createTestRun(db, "feat");
    db.sessions.create({
      id: "s2",
      name: "planner-1",
      logical_name: "planner-1",
      attempt: 1,
      runtime: "claude",
      capability: "planner",
      feature: "feat",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "booting",
      parent_agent: null,
      run_id: runId,
    });

    db.sessions.updateState("planner-1", "working");
    expect(db.sessions.get("planner-1")!.state).toBe("working");

    db.sessions.updateState("planner-1", "failed", "process died");
    const session = db.sessions.get("planner-1")!;
    expect(session.state).toBe("failed");
    expect(session.error).toBe("process died");
    expect(session.completed_at).toBeTruthy();
  });

  it("records heartbeat", () => {
    const runId = createTestRun(db);
    db.sessions.create({
      id: "s3",
      name: "hb-test",
      logical_name: "hb-test",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: null,
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });

    db.sessions.heartbeat("hb-test");
    const session = db.sessions.get("hb-test")!;
    expect(session.last_heartbeat).toBeTruthy();
  });

  it("records per-session progress snapshots separately from lifecycle state", () => {
    const runId = createTestRun(db, "auth");
    db.sessions.create({
      id: "s-progress",
      name: "builder-progress",
      logical_name: "builder-progress",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: "/tmp/wt",
      transcript_path: ".cnog/features/auth/runs/run-test-1/sessions/builder-progress.log",
      branch: "cnog/auth/builder-progress",
      tmux_session: "cnog-builder-progress",
      pid: 1234,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });

    db.sessionProgress.recordActivity({
      sessionId: "s-progress",
      runId,
      transcriptPath: ".cnog/features/auth/runs/run-test-1/sessions/builder-progress.log",
      transcriptSize: 128,
      toolName: "Write",
      activityKind: "write",
      summary: "Modified src/auth.ts",
      target: "src/auth.ts",
    });

    const progress = db.sessionProgress.get("s-progress");
    expect(progress).toMatchObject({
      session_id: "s-progress",
      run_id: runId,
      transcript_path: ".cnog/features/auth/runs/run-test-1/sessions/builder-progress.log",
      transcript_size: 128,
      last_activity_kind: "write",
      last_activity_summary: "Modified src/auth.ts",
      last_tool_name: "Write",
      tool_use_count: 1,
    });
    expect(JSON.parse(progress!.recent_activities_json)).toEqual([
      expect.objectContaining({
        kind: "write",
        tool: "Write",
        target: "src/auth.ts",
        summary: "Modified src/auth.ts",
      }),
    ]);
    expect(db.sessions.get("builder-progress")?.state).toBe("working");
  });

  it("mirrors session progress into structured execution task control state", () => {
    const runId = createTestRun(db, "auth");
    db.executionTasks.create({
      id: "xtask-progress",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:auth-progress",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Running build",
      output_path: ".cnog/features/auth/runs/run-test-1/tasks/xtask-progress.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    db.sessions.create({
      id: "s-progress-task",
      name: "builder-progress-task",
      logical_name: "builder-progress-task",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: "xtask-progress",
      worktree_path: null,
      transcript_path: ".cnog/features/auth/runs/run-test-1/sessions/builder-progress-task.log",
      branch: "cnog/auth/builder-progress-task",
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.executionTasks.update("xtask-progress", {
      active_session_id: "s-progress-task",
    });

    db.sessionProgress.recordActivity({
      sessionId: "s-progress-task",
      runId,
      executionTaskId: "xtask-progress",
      transcriptPath: ".cnog/features/auth/runs/run-test-1/sessions/builder-progress-task.log",
      transcriptSize: 256,
      toolName: "Write",
      activityKind: "write",
      summary: "Modified src/auth.ts",
      target: "src/auth.ts",
    });
    db.sessionProgress.update("s-progress-task", {
      input_tokens: 11,
      output_tokens: 7,
      cost_usd: 0.0125,
    });

    const controlState = db.executionTasks.controlState("xtask-progress");
    expect(controlState.progress.toolUseCount).toBe(1);
    expect(controlState.progress.inputTokens).toBe(11);
    expect(controlState.progress.outputTokens).toBe(7);
    expect(controlState.progress.costUsd).toBe(0.0125);
    expect(controlState.progress.lastActivitySummary).toBe("Modified src/auth.ts");
    expect(controlState.progress.recentActivities).toEqual([
      expect.objectContaining({
        kind: "write",
        tool: "Write",
        target: "src/auth.ts",
      }),
    ]);
  });

  it("lists active sessions", () => {
    const runId = createTestRun(db);
    db.sessions.create({
      id: "a1",
      name: "active-1",
      logical_name: "active-1",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: null,
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.sessions.create({
      id: "a2",
      name: "done-1",
      logical_name: "done-1",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: null,
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });

    const active = db.sessions.active();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe("active-1");
  });

  it("migrates a compatible legacy sessions table by adding transcript_path", () => {
    db.close();

    const legacyPath = join(tmpDir, "legacy-transcript.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        plan_number TEXT,
        status TEXT NOT NULL,
        phase_reason TEXT,
        profile TEXT,
        tasks TEXT,
        review TEXT,
        ship TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        logical_name TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        runtime TEXT NOT NULL,
        capability TEXT NOT NULL,
        feature TEXT,
        task_id TEXT,
        execution_task_id TEXT,
        worktree_path TEXT,
        branch TEXT,
        tmux_session TEXT,
        pid INTEGER,
        state TEXT NOT NULL,
        parent_agent TEXT,
        run_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT,
        completed_at TEXT,
        error TEXT
      );
    `);
    legacyDb.close();

    const migrated = new CnogDB(legacyPath);
    const columns = migrated.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("transcript_path");
    migrated.close();

    db = new CnogDB(join(tmpDir, "test.db"));
  });

  it("migrates legacy execution_tasks without replaying historical terminal rows", () => {
    db.close();

    const legacyPath = join(tmpDir, "legacy-execution-tasks.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        plan_number TEXT,
        status TEXT NOT NULL,
        phase_reason TEXT,
        profile TEXT,
        tasks TEXT,
        review TEXT,
        ship TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE execution_tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        issue_id TEXT,
        review_scope_id TEXT,
        logical_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        capability TEXT NOT NULL,
        status TEXT NOT NULL,
        active_session_id TEXT,
        summary TEXT,
        output_path TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
    `);
    legacyDb.prepare(`
      INSERT INTO runs (id, feature, plan_number, status, phase_reason, profile, tasks, review, ship, worktree_path, created_at, updated_at)
      VALUES (?, ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, datetime('now'), datetime('now'))
    `).run("run-legacy", "auth", "build");
    legacyDb.prepare(`
      INSERT INTO execution_tasks (id, run_id, issue_id, review_scope_id, logical_name, kind, capability, status, active_session_id, summary, output_path, last_error, created_at, updated_at, completed_at)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, NULL, datetime('now'), datetime('now'), datetime('now'))
    `).run(
      "xtask-old-completed",
      "run-legacy",
      "implementation_review:run-legacy",
      "implementation_review",
      "evaluator",
      "completed",
      "Completed long ago",
      ".cnog/features/auth/runs/run-legacy/review-report.json",
    );
    legacyDb.prepare(`
      INSERT INTO execution_tasks (id, run_id, issue_id, review_scope_id, logical_name, kind, capability, status, active_session_id, summary, output_path, last_error, created_at, updated_at, completed_at)
      VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, NULL, NULL, datetime('now'), datetime('now'), NULL)
    `).run(
      "xtask-old-running",
      "run-legacy",
      "build:issue-1",
      "build",
      "builder",
      "running",
      "Still running",
    );
    legacyDb.close();

    const migrated = new CnogDB(legacyPath);
    expect(migrated.executionTasks.get("xtask-old-completed")).toMatchObject({
      executor: "agent",
      output_path: null,
      result_path: ".cnog/features/auth/runs/run-legacy/review-report.json",
      parent_task_id: null,
      notified: 1,
    });
    expect(migrated.executionTasks.get("xtask-old-completed")?.notified_at).toBeTruthy();
    expect(migrated.executionTasks.get("xtask-old-running")).toMatchObject({
      executor: "agent",
      parent_task_id: null,
      result_path: null,
      notified: 0,
    });
    expect(() => migrated.executionTasks.update("xtask-old-running", { status: "superseded" })).not.toThrow();
    migrated.close();

    db = new CnogDB(join(tmpDir, "test.db"));
  });
});

describe("artifacts", () => {
  it("migrates legacy artifact schemas so prompt-contract artifacts are allowed", () => {
    db.close();

    const legacyPath = join(tmpDir, "legacy-artifacts.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('plan','contract','checkpoint','review-scope','review-report','grading-report','verify-report','merge-record','ship-report')),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        issue_id TEXT,
        session_id TEXT,
        review_scope_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacyDb.close();

    const migrated = new CnogDB(legacyPath);
    const runId = createTestRun(migrated, "auth");

    migrated.artifacts.create({
      id: "art-prompt-auth-1",
      run_id: runId,
      feature: "auth",
      type: "prompt-contract",
      path: ".cnog/features/auth/runs/run-test-1/prompt-contract.json",
      hash: "abc123",
      issue_id: null,
      session_id: null,
      review_scope_id: null,
    });

    expect(migrated.artifacts.get("art-prompt-auth-1")?.type).toBe("prompt-contract");
    migrated.close();

    db = new CnogDB(join(tmpDir, "test.db"));
  });

  it("recreates messages and artifacts indexes after rebuilding legacy tables", () => {
    db.close();

    const legacyPath = join(tmpDir, "legacy-index-rebuild.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        plan_number TEXT,
        status TEXT NOT NULL,
        phase_reason TEXT,
        profile TEXT,
        tasks TEXT,
        review TEXT,
        ship TEXT,
        worktree_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        body TEXT,
        type TEXT NOT NULL CHECK(type IN ('status','worker_done','result')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        thread_id TEXT,
        payload TEXT,
        run_id TEXT REFERENCES runs(id),
        read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('plan','contract','checkpoint','review-scope','review-report','grading-report','verify-report','merge-record','ship-report')),
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        issue_id TEXT,
        session_id TEXT,
        review_scope_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    legacyDb.close();

    const migrated = new CnogDB(legacyPath);
    const messageIndexes = migrated.db.prepare("PRAGMA index_list(messages)").all() as Array<{ name: string }>;
    const artifactIndexes = migrated.db.prepare("PRAGMA index_list(artifacts)").all() as Array<{ name: string }>;
    expect(messageIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_messages_to_read",
      "idx_messages_thread",
      "idx_messages_run",
    ]));
    expect(artifactIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_artifacts_run",
      "idx_artifacts_type",
      "idx_artifacts_feature",
    ]));
    migrated.close();

    db = new CnogDB(join(tmpDir, "test.db"));
  });
});

describe("messages", () => {
  it("sends and checks mail", () => {
    const id = db.messages.send({
      from_agent: "builder-1",
      to_agent: "orchestrator",
      subject: "done",
      body: "all good",
      type: "worker_notification",
      priority: "high",
      thread_id: null,
      payload: null,
      run_id: null,
    });

    expect(id).toBeGreaterThan(0);

    const unread = db.messages.checkMail("orchestrator");
    expect(unread).toHaveLength(1);
    expect(unread[0].subject).toBe("done");
    expect(unread[0].read).toBe(0);
  });

  it("marks messages as read", () => {
    const id = db.messages.send({
      from_agent: "a",
      to_agent: "b",
      subject: "test",
      body: null,
      type: "status",
      priority: "normal",
      thread_id: null,
      payload: null,
      run_id: null,
    });

    db.messages.markRead(id);
    const unread = db.messages.checkMail("b");
    expect(unread).toHaveLength(0);
  });
});

describe("merge_queue", () => {
  it("enqueues and retrieves pending merges", () => {
    const runId = createTestRun(db, "auth");
    const sessionId = "sess-merge-1";
    db.sessions.create({
      id: sessionId, name: "builder-merge-1", logical_name: "builder-merge-1", attempt: 1,
      runtime: "claude", capability: "builder", feature: "auth", task_id: null,
      execution_task_id: null,
      worktree_path: null, transcript_path: null, branch: "cnog/auth/builder", tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: runId,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder",
      agent_name: "builder",
      run_id: runId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: "[\"src/auth.ts\"]",
    });

    const pending = db.merges.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].branch).toBe("cnog/auth/builder");
  });

  it("updates merge status", () => {
    const runId = createTestRun(db, "auth");
    const sessionId = "sess-merge-2";
    db.sessions.create({
      id: sessionId, name: "builder-merge-2", logical_name: "builder-merge-2", attempt: 1,
      runtime: "claude", capability: "builder", feature: "auth", task_id: null,
      execution_task_id: null,
      worktree_path: null, transcript_path: null, branch: "cnog/auth/builder", tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: runId,
    });
    const id = db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder",
      agent_name: "builder",
      run_id: runId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });

    db.merges.updateStatus(id, "merged", "clean");
    const pending = db.merges.pending();
    expect(pending).toHaveLength(0);
  });
});

describe("execution_tasks", () => {
  it("creates, lists, and updates runtime execution tasks", () => {
    const runId = createTestRun(db, "auth");

    db.executionTasks.create({
      id: "xtask-1",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:iss-1",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "pending",
      active_session_id: null,
      summary: "Ready to build",
      output_path: ".cnog/features/auth/runs/run-test-1/tasks/xtask-1.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    expect(db.executionTasks.getByLogicalName(runId, "build:iss-1")?.id).toBe("xtask-1");
    expect(db.executionTasks.active(runId)).toHaveLength(1);

    db.executionTasks.update("xtask-1", {
      status: "running",
      summary: "Builder running",
    });
    expect(db.executionTasks.get("xtask-1")?.status).toBe("running");

    db.executionTasks.update("xtask-1", {
      status: "completed",
      summary: "Completed",
      active_session_id: null,
    });
    const task = db.executionTasks.get("xtask-1");
    expect(task?.status).toBe("completed");
    expect(task?.completed_at).toBeTruthy();
    expect(db.executionTasks.active(runId)).toHaveLength(0);
  });

  it("treats blocked execution tasks as non-active work and clears completed_at", () => {
    const runId = createTestRun(db, "auth");

    db.executionTasks.create({
      id: "xtask-blocked",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "implementation_review:auth",
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "completed",
      active_session_id: null,
      summary: "Completed once",
      output_path: ".cnog/features/auth/runs/run-test-1/tasks/xtask-blocked.output",
      result_path: ".cnog/features/auth/runs/run-test-1/review-report.json",
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    db.executionTasks.update("xtask-blocked", {
      status: "blocked",
      summary: "Blocked on upstream dependency",
      result_path: null,
      last_error: "missing_dependency",
    });

    const blocked = db.executionTasks.get("xtask-blocked");
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.completed_at).toBeNull();
    expect(db.executionTasks.active(runId)).toHaveLength(0);
  });

  it("tracks parent-child execution task lineage and excludes superseded work from active views", () => {
    const runId = createTestRun(db, "auth");

    db.executionTasks.create({
      id: "xtask-parent",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:auth-parent",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Parent build",
      output_path: ".cnog/features/auth/runs/run-test-1/tasks/xtask-parent.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.executionTasks.create({
      id: "xtask-child",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: "xtask-parent",
      logical_name: "verify:auth-parent:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Verify passed",
      output_path: ".cnog/features/auth/runs/run-test-1/tasks/xtask-child.output",
      result_path: ".cnog/features/auth/runs/run-test-1/verify-report.json",
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });

    expect(db.executionTasks.childrenOf("xtask-parent").map((task) => task.id)).toEqual(["xtask-child"]);

    db.executionTasks.update("xtask-child", {
      status: "superseded",
      summary: "Superseded by parent retry",
    });

    expect(db.executionTasks.active(runId).map((task) => task.id)).toEqual(["xtask-parent"]);
    expect(db.executionTasks.get("xtask-child")?.completed_at).toBeTruthy();
  });

  it("clears completed_at when a task is reopened for another attempt", () => {
    const runId = createTestRun(db, "auth");

    db.executionTasks.create({
      id: "xtask-reopen",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "verify:scope-1:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "pending",
      active_session_id: null,
      summary: "Ready to verify",
      output_path: ".cnog/features/auth/runs/run-test-2/tasks/xtask-reopen.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    db.executionTasks.update("xtask-reopen", {
      status: "completed",
      summary: "Completed",
    });
    expect(db.executionTasks.get("xtask-reopen")?.completed_at).toBeTruthy();

    db.executionTasks.update("xtask-reopen", {
      status: "running",
      summary: "Running again",
    });

    const reopened = db.executionTasks.get("xtask-reopen");
    expect(reopened?.status).toBe("running");
    expect(reopened?.completed_at).toBeNull();
  });

  it("tracks notification delivery and reopen counts in control state", () => {
    const runId = createTestRun(db, "auth");

    db.executionTasks.create({
      id: "xtask-control",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "verify:scope-control:00",
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "pending",
      active_session_id: null,
      summary: "Ready to verify",
      output_path: ".cnog/features/auth/runs/run-test-2/tasks/xtask-control.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    expect(db.executionTasks.controlState("xtask-control")).toMatchObject({
      lifecycle: {
        currentStatus: "pending",
        transitionCount: 0,
        reopenedCount: 0,
        terminalCount: 0,
      },
      notification: {
        delivery: "idle",
        sequence: 0,
      },
    });

    db.executionTasks.update("xtask-control", {
      status: "completed",
      summary: "Verify passed",
    });
    expect(db.executionTasks.controlState("xtask-control")).toMatchObject({
      lifecycle: {
        currentStatus: "completed",
        transitionCount: 1,
        reopenedCount: 0,
        terminalCount: 1,
      },
      notification: {
        delivery: "pending",
        sequence: 1,
        lastTerminalStatus: "completed",
      },
    });

    db.executionTasks.markNotified("xtask-control");
    expect(db.executionTasks.controlState("xtask-control")).toMatchObject({
      notification: {
        delivery: "delivered",
        sequence: 1,
      },
    });

    db.executionTasks.update("xtask-control", {
      status: "running",
      notified: 0,
      notified_at: null,
      result_path: null,
      last_error: null,
      summary: "Running again",
    });
    expect(db.executionTasks.controlState("xtask-control")).toMatchObject({
      lifecycle: {
        currentStatus: "running",
        transitionCount: 2,
        reopenedCount: 1,
        terminalCount: 1,
      },
      notification: {
        delivery: "idle",
        sequence: 1,
      },
    });
  });
});

describe("events", () => {
  it("logs and queries events", () => {
    db.events.log({
      level: "info",
      source: "agents",
      event_type: "agent_spawned",
      agent_name: "builder-1",
      feature: "auth",
      message: "Spawned builder-1",
      data: null,
    });

    const events = db.events.query({ agent: "builder-1" });
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe("Spawned builder-1");
  });
});

describe("feature_phases", () => {
  it("sets and gets phase", () => {
    db.phases.set("auth", "discuss");
    const row = db.phases.get("auth");
    expect(row).toBeDefined();
    expect(row!.phase).toBe("discuss");
  });

  it("upserts phase", () => {
    db.phases.set("auth", "discuss");
    db.phases.set("auth", "plan");
    expect(db.phases.get("auth")!.phase).toBe("plan");
  });

  it("sets review verdict", () => {
    db.phases.set("auth", "review");
    db.phases.setVerdict("auth", "APPROVE");
    expect(db.phases.get("auth")!.review_verdict).toBe("APPROVE");
  });

  it("stores the active feature profile", () => {
    db.phases.set("auth", "plan");
    db.phases.setProfile("auth", "migration-rollout");
    expect(db.phases.get("auth")!.profile).toBe("migration-rollout");
  });

  it("clears stale review verdicts when a feature moves back to build", () => {
    db.phases.set("auth", "review");
    db.phases.setVerdict("auth", "APPROVE");
    db.phases.set("auth", "build");

    expect(db.phases.get("auth")!.review_verdict).toBeNull();
  });
});

describe("issues", () => {
  it("creates and retrieves issues", () => {
    const runId = createTestRun(db, "auth");
    db.issues.create({
      id: "cn-abc123",
      title: "Implement auth",
      description: "Add JWT support",
      issue_type: "task",
      status: "open",
      priority: 1,
      assignee: null,
      feature: "auth",
      run_id: runId,
      plan_number: "01",
      phase: null,
      parent_id: null,
      metadata: null,
    });

    const issue = db.issues.get("cn-abc123");
    expect(issue).toBeDefined();
    expect(issue!.title).toBe("Implement auth");
    expect(issue!.status).toBe("open");
  });

  it("closes issues", () => {
    const runId = createTestRun(db);
    db.issues.create({
      id: "cn-close1",
      title: "Close me",
      description: null,
      issue_type: "task",
      status: "open",
      priority: 1,
      assignee: null,
      feature: null,
      run_id: runId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });

    db.issues.close("cn-close1");
    const issue = db.issues.get("cn-close1")!;
    expect(issue.status).toBe("closed");
    expect(issue.closed_at).toBeTruthy();
  });

  it("manages dependencies", () => {
    db.issues.addDep("task-2", "task-1");
    const deps = db.issues.getDeps("task-2");
    expect(deps).toHaveLength(1);
    expect(deps[0].depends_on).toBe("task-1");
  });
});
