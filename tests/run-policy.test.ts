import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MemoryEngine } from "../src/memory.js";
import { ContractManager } from "../src/contracts.js";
import { decideNextRunAction } from "../src/run-policy.js";

describe("run next-action policy", () => {
  let tmpDir: string;
  let db: CnogDB;
  let events: EventEmitter;
  let memory: MemoryEngine;
  let contracts: ContractManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-run-policy-"));
    db = new CnogDB(join(tmpDir, "test.db"));
    events = new EventEmitter(db);
    memory = new MemoryEngine(db);
    contracts = new ContractManager(db, events, tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRun(status: "plan" | "contract" | "build" | "evaluate" = "contract"): string {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.runs.create({
      id: runId,
      feature: "auth",
      plan_number: "01",
      status,
      phase_reason: null,
      profile: "feature-delivery",
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });
    return runId;
  }

  it("requests contract proposal while a run is still in plan", () => {
    const runId = createRun("plan");
    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("propose_contracts");
  });

  it("requests evaluator review for pending contracts", () => {
    const runId = createRun("contract");
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });

    contracts.propose({
      id: "contract-a",
      taskId: issue.id,
      runId,
      feature: "auth",
      agentName: "builder-auth-a",
      acceptanceCriteria: [{ description: "Do the thing", testable: true }],
      verifyCommands: ["npm test"],
      fileScope: ["src/a.ts"],
      status: "proposed",
      proposedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("spawn_contract_evaluator");
  });

  it("requests builder spawning when ready work has accepted contracts", () => {
    const runId = createRun("contract");
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });

    contracts.propose({
      id: "contract-a",
      taskId: issue.id,
      runId,
      feature: "auth",
      agentName: "builder-auth-a",
      acceptanceCriteria: [{ description: "Do the thing", testable: true }],
      verifyCommands: ["npm test"],
      fileScope: ["src/a.ts"],
      status: "proposed",
      proposedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
    });
    contracts.accept("contract-a", "auth", "evaluator-auth");

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("spawn_builders");
  });

  it("treats a running contract-review execution task as in-flight work", () => {
    const runId = createRun("contract");
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });

    contracts.propose({
      id: "contract-a",
      taskId: issue.id,
      runId,
      feature: "auth",
      agentName: "builder-auth-a",
      acceptanceCriteria: [{ description: "Do the thing", testable: true }],
      verifyCommands: ["npm test"],
      fileScope: ["src/a.ts"],
      status: "proposed",
      proposedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
    });

    db.executionTasks.create({
      id: "xtask-contract-review",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `contract_review:${runId}`,
      kind: "contract_review",
      capability: "evaluator",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Reviewing pending contracts",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-contract-review.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("idle");
    expect(action.reason).toContain("Contract evaluator");
  });

  it("treats a blocked contract-review execution task as blocked work instead of respawning it", () => {
    const runId = createRun("contract");
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });

    contracts.propose({
      id: "contract-a",
      taskId: issue.id,
      runId,
      feature: "auth",
      agentName: "builder-auth-a",
      acceptanceCriteria: [{ description: "Do the thing", testable: true }],
      verifyCommands: ["npm test"],
      fileScope: ["src/a.ts"],
      status: "proposed",
      proposedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null,
    });

    db.executionTasks.create({
      id: "xtask-contract-review-blocked",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `contract_review:${runId}`,
      kind: "contract_review",
      capability: "evaluator",
      executor: "agent",
      status: "blocked",
      active_session_id: null,
      summary: "Blocked: waiting on contract clarification",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-contract-review-blocked.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: "need_clarification",
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("blocked");
    expect(action.reason).toContain("Blocked");
  });

  it("treats a running build execution task as in-flight work", () => {
    const runId = createRun("build");
    db.executionTasks.create({
      id: "xtask-build-auth",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-auth",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-build-auth.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("idle");
    expect(action.reason).toContain("Build work");
  });

  it("treats a running implementation-review execution task as in-flight work", () => {
    const runId = createRun("evaluate");
    db.reviewScopes.create({
      id: "scope-auth",
      run_id: runId,
      scope_status: "evaluating",
      scope_hash: "scope-auth-hash",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });
    db.executionTasks.create({
      id: "xtask-implementation-review",
      run_id: runId,
      issue_id: null,
      review_scope_id: "scope-auth",
      parent_task_id: null,
      logical_name: `implementation_review:${runId}`,
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Evaluator running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-implementation-review.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.sessions.create({
      id: "session-build",
      name: "builder-auth-finished",
      logical_name: "builder-auth-finished",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/builder-auth-finished",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth-finished",
      agent_name: "builder-auth-finished",
      run_id: runId,
      session_id: "session-build",
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("idle");
    expect(action.reason).toContain("Implementation evaluator");
  });

  it("treats a blocked implementation-review execution task as blocked work instead of respawning it", () => {
    const runId = createRun("evaluate");
    db.sessions.create({
      id: "session-build",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/builder-auth",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.reviewScopes.create({
      id: "scope-auth-blocked",
      run_id: runId,
      scope_status: "evaluating",
      scope_hash: "scope-auth-blocked-hash",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });
    db.executionTasks.create({
      id: "xtask-implementation-review-blocked",
      run_id: runId,
      issue_id: null,
      review_scope_id: "scope-auth-blocked",
      parent_task_id: null,
      logical_name: `implementation_review:${runId}`,
      kind: "implementation_review",
      capability: "evaluator",
      executor: "agent",
      status: "blocked",
      active_session_id: null,
      summary: "Blocked: waiting on external environment",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-implementation-review-blocked.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: "external_blocker",
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: runId,
      session_id: "session-build",
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });

    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("blocked");
    expect(action.reason).toContain("Blocked");
  });

  it("requests implementation evaluation when build work is finished", () => {
    const runId = createRun("build");
    db.sessions.create({
      id: "session-build",
      name: "builder-auth-finished",
      logical_name: "builder-auth-finished",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/builder-auth-finished",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth-finished",
      agent_name: "builder-auth-finished",
      run_id: runId,
      session_id: "session-build",
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });
    const action = decideNextRunAction({ runId, db, memory, projectRoot: tmpDir });
    expect(action.kind).toBe("spawn_implementation_evaluator");
  });
});
