import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      worktree_path: "/tmp/wt",
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
      worktree_path: null,
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
      worktree_path: null,
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
      worktree_path: null,
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
      worktree_path: null,
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
      worktree_path: null,
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
      worktree_path: null,
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
});

describe("messages", () => {
  it("sends and checks mail", () => {
    const id = db.messages.send({
      from_agent: "builder-1",
      to_agent: "orchestrator",
      subject: "done",
      body: "all good",
      type: "worker_done",
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
      worktree_path: null, branch: "cnog/auth/builder", tmux_session: null, pid: null,
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
      worktree_path: null, branch: "cnog/auth/builder", tmux_session: null, pid: null,
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
