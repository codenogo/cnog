import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MemoryEngine } from "../src/memory.js";
import { Lifecycle } from "../src/lifecycle.js";
import { Dispatcher } from "../src/dispatch.js";
import { ExecutionEngine } from "../src/execution.js";
import type { AgentIdentity, AgentInfo } from "../src/agents.js";
import type { Capability } from "../src/types.js";
import { ContractManager } from "../src/contracts.js";
import { MergeQueue } from "../src/merge.js";
import { CnogError } from "../src/errors.js";

describe("Dispatcher", () => {
  let tmpDir: string;
  let db: CnogDB;
  let events: EventEmitter;
  let memory: MemoryEngine;
  let lifecycle: Lifecycle;
  let spawnCalls: Array<Record<string, unknown>>;
  let dispatcher: Dispatcher;
  let execution: ExecutionEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-dispatch-test-"));
    db = new CnogDB(join(tmpDir, "test.db"));
    events = new EventEmitter(db);
    memory = new MemoryEngine(db);
    lifecycle = new Lifecycle(db, events, tmpDir);
    spawnCalls = [];

    const agents = {
      allocateIdentity(logicalName: string): AgentIdentity {
        const latest = db.sessions.getLatestByLogicalName(logicalName);
        const attempt = latest ? latest.attempt + 1 : 1;
        return {
          logicalName,
          attempt,
          name: attempt === 1 ? logicalName : `${logicalName}-r${attempt}`,
        };
      },
      spawn(opts: Record<string, unknown>): AgentInfo {
        spawnCalls.push(opts);
        const identity = opts.identity as AgentIdentity;
        const sessionId = `session-${identity.name}`;
        db.sessions.create({
          id: sessionId,
          name: identity.name,
          logical_name: identity.logicalName,
          attempt: identity.attempt,
          runtime: String(opts.runtimeId),
          capability: opts.capability as Capability,
          feature: String(opts.feature),
          task_id: (opts.taskId as string | undefined) ?? null,
          execution_task_id: (opts.executionTaskId as string | undefined) ?? null,
          worktree_path: "/tmp/worktree",
          transcript_path: `.cnog/features/${String(opts.feature)}/runs/${String(opts.runId)}/sessions/${identity.name}.log`,
          branch: `cnog/${String(opts.feature)}/${identity.name}`,
          tmux_session: "cnog-test",
          pid: 123,
          state: "working",
          parent_agent: null,
          run_id: String(opts.runId),
        });
        return {
          id: sessionId,
          name: identity.name,
          runtime: String(opts.runtimeId),
          capability: opts.capability as Capability,
          feature: String(opts.feature),
          state: "working",
          branch: (opts.baseBranch as string | undefined) ?? null,
          worktreePath: "/tmp/worktree",
          transcriptPath: `.cnog/features/${String(opts.feature)}/runs/${String(opts.runId)}/sessions/${identity.name}.log`,
          tmuxSession: "cnog-test",
          pid: 123,
          parentAgent: null,
          startedAt: new Date().toISOString(),
          lastHeartbeat: null,
          error: null,
        };
      },
    };

    const mergeQueue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    dispatcher = new Dispatcher(db, lifecycle, memory, events, tmpDir);
    execution = new ExecutionEngine(
      db,
      agents as never,
      lifecycle,
      memory,
      mergeQueue,
      events,
      dispatcher,
      "claude",
      "main",
      tmpDir,
    );

    const featureDir = join(tmpDir, "docs", "planning", "work", "features", "auth");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, "01-PLAN.json"), JSON.stringify({
      schemaVersion: 3,
      feature: "auth",
      planNumber: "01",
      goal: "Deliver auth",
      profile: "migration-rollout",
      tasks: [
        {
          name: "Task A",
          files: ["src/a.ts"],
          action: "Implement dependency",
          verify: ["npm test"],
        },
        {
          name: "Task B",
          files: ["src/b.ts"],
          action: "Build on Task A",
          verify: ["npm run lint"],
          blockedBy: ["Task A"],
        },
      ],
      planVerify: ["npm test"],
      commitMessage: "feat(auth): deliver auth",
    }), "utf-8");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists the selected profile and seeds dependent work from the dependency branch", () => {
    const firstResults = dispatcher.dispatchFeature("auth", "migration-rollout");

    expect(spawnCalls).toHaveLength(0);
    expect(firstResults.some((result) => result.status === "proposed")).toBe(true);

    // Dispatcher creates a run and stores profile in the phases cache
    const run = db.runs.latestForFeature("auth");
    expect(run).toBeDefined();
    expect(run!.profile).toBe("migration-rollout");

    const taskA = memory.list({ feature: "auth" }).find((issue) => issue.title === "Task A");
    const taskB = memory.list({ feature: "auth" }).find((issue) => issue.title === "Task B");
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();

    const contracts = new ContractManager(db, events, tmpDir);
    const taskAContract = contracts.loadLatestForIssue(taskA!.id, "auth");
    expect(taskAContract?.status).toBe("pending_review");
    contracts.accept(taskAContract!.id, "auth", "evaluator-auth");

    const firstSpawn = execution.spawnAccepted("auth", "migration-rollout");
    expect(firstSpawn.some((result) => result.status === "spawned")).toBe(true);
    expect(db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]?.status).toBe("running");

    expect(spawnCalls).toHaveLength(1);
    const firstIdentity = spawnCalls[0].identity as AgentIdentity;
    const firstAgentName = firstIdentity.name;
    expect(spawnCalls[0].verifyCommands).toEqual([]);
    expect((spawnCalls[0].assignmentSpec as { canonicalVerifyCommands: string[] }).canonicalVerifyCommands)
      .toContain("npx tsc --noEmit");

    memory.done(taskA!.id, firstAgentName);
    db.sessions.updateState(firstAgentName, "completed");
    db.db.prepare("UPDATE sessions SET branch = ? WHERE name = ?").run(`cnog/auth/${firstAgentName}`, firstAgentName);
    db.executionTasks.update(
      db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]!.id,
      { status: "completed", active_session_id: null, summary: "Completed" },
    );

    spawnCalls = [];
    dispatcher.dispatchFeature("auth");
    expect(execution.spawnAccepted("auth")).toEqual([]);

    const taskBContract = contracts.loadLatestForIssue(taskB!.id, "auth");
    expect(taskBContract?.status).toBe("pending_review");
    contracts.accept(taskBContract!.id, "auth", "evaluator-auth");

    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].taskId).toBe(taskB!.id);
    expect(db.executionTasks.list({ run_id: run!.id, issue_id: taskB!.id })[0]?.kind).toBe("build");
    expect(spawnCalls[0].baseBranch).toBe(`cnog/auth/${firstAgentName}`);
    expect(spawnCalls[0].seedBranches).toEqual([]);
    expect(spawnCalls[0].verifyCommands).toEqual([]);
    expect((spawnCalls[0].assignmentSpec as { canonicalVerifyCommands: string[] }).canonicalVerifyCommands)
      .toContain("npx tsc --noEmit");
  });

  it("allocates a new concrete agent name when retrying a completed task", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");

    const taskA = memory.list({ feature: "auth" }).find((issue) => issue.title === "Task A");
    expect(taskA).toBeDefined();

    const run = db.runs.latestForFeature("auth");
    expect(run).toBeDefined();

    const contracts = new ContractManager(db, events, tmpDir);
    const taskAContract = contracts.loadLatestForIssue(taskA!.id, "auth");
    contracts.accept(taskAContract!.id, "auth", "evaluator-auth");

    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);

    const firstIdentity = spawnCalls[0].identity as AgentIdentity;
    const firstAgentName = firstIdentity.name;
    db.sessions.updateState(firstAgentName, "completed");
    db.db.prepare("UPDATE sessions SET branch = ? WHERE name = ?").run("cnog/auth/retry-a", firstAgentName);
    db.executionTasks.update(
      db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]!.id,
      { status: "completed", active_session_id: null, summary: "Completed" },
    );
    db.issues.update(taskA!.id, { status: "open", assignee: null });

    spawnCalls = [];
    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);
    const retryIdentity = spawnCalls[0].identity as AgentIdentity;
    expect(retryIdentity.logicalName).toBe(firstAgentName);
    expect(retryIdentity.attempt).toBe(2);
    expect(retryIdentity.name).toBe(`${firstAgentName}-r2`);
  });

  it("supersedes child verify and merge work when a build task is retried", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");

    const taskA = memory.list({ feature: "auth" }).find((issue) => issue.title === "Task A");
    expect(taskA).toBeDefined();

    const run = db.runs.latestForFeature("auth");
    expect(run).toBeDefined();

    const contracts = new ContractManager(db, events, tmpDir);
    const taskAContract = contracts.loadLatestForIssue(taskA!.id, "auth");
    contracts.accept(taskAContract!.id, "auth", "evaluator-auth");

    execution.spawnAccepted("auth");
    const firstIdentity = spawnCalls[0].identity as AgentIdentity;
    const firstAgentName = firstIdentity.name;
    const firstSession = db.sessions.get(firstAgentName)!;
    const buildTask = db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]!;

    db.sessions.updateState(firstAgentName, "completed");
    db.db.prepare("UPDATE sessions SET branch = ? WHERE name = ?").run("cnog/auth/retry-a", firstAgentName);
    db.executionTasks.update(buildTask.id, {
      status: "completed",
      active_session_id: null,
      summary: "Completed",
    });
    db.executionTasks.create({
      id: "xtask-verify-child",
      run_id: run!.id,
      issue_id: taskA!.id,
      review_scope_id: null,
      parent_task_id: buildTask.id,
      logical_name: `verify:${taskA!.id}:00`,
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "completed",
      active_session_id: null,
      summary: "Verify passed",
      output_path: `.cnog/features/auth/runs/${run!.id}/tasks/xtask-verify-child.output`,
      result_path: `.cnog/features/auth/runs/${run!.id}/verify-report.json`,
      output_offset: 0,
      notified: 1,
      notified_at: "2026-04-01 10:00:00",
      last_error: null,
    });
    const mergeQueue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    const mergeEntryId = mergeQueue.enqueue({
      feature: "auth",
      branch: "cnog/auth/retry-a",
      agentName: firstAgentName,
      runId: run!.id,
      sessionId: firstSession.id,
      taskId: taskA!.id,
      headSha: "abc123",
      filesModified: ["src/a.ts"],
    });
    db.executionTasks.update(`xtask-merge-${mergeEntryId}`, {
      parent_task_id: null,
      summary: "Legacy orphaned merge task",
    });

    db.issues.update(taskA!.id, { status: "open", assignee: null });
    spawnCalls = [];
    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);
    expect(db.executionTasks.get("xtask-verify-child")?.status).toBe("superseded");
    expect(db.executionTasks.get(`xtask-merge-${mergeEntryId}`)?.status).toBe("superseded");
    expect(db.merges.listForRun(run!.id).find((entry) => entry.id === mergeEntryId)?.status).toBe("failed");
  });

  it("spawns an evaluator for pending contracts before builders start", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");

    const results = execution.spawnAccepted("auth", "migration-rollout");

    expect(results.some((result) => result.status === "spawned")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].capability).toBe("evaluator");
    const run = db.runs.latestForFeature("auth")!;
    expect(db.executionTasks.getByLogicalName(run.id, `contract_review:${run.id}`)?.status).toBe("running");
    expect(String(spawnCalls[0].completionCommand)).toContain("cnog report contract-review");
  });

  it("creates a fresh issue DAG for each new run of the same feature", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");
    const firstRun = db.runs.latestForFeature("auth");
    expect(firstRun).toBeDefined();

    const firstIssueIds = db.issues.list({ run_id: firstRun!.id }).map((issue) => issue.id);
    expect(firstIssueIds).toHaveLength(2);

    db.runs.update(firstRun!.id, { status: "done" });

    dispatcher.dispatchFeature("auth", "migration-rollout");
    const secondRun = db.runs.latestForFeature("auth");
    expect(secondRun).toBeDefined();
    expect(secondRun!.id).not.toBe(firstRun!.id);

    const secondIssueIds = db.issues.list({ run_id: secondRun!.id }).map((issue) => issue.id);
    expect(secondIssueIds).toHaveLength(2);
    expect(secondIssueIds).not.toEqual(firstIssueIds);
  });

  it("fails the run when evaluator retries are exhausted", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");
    const run = db.runs.latestForFeature("auth");
    expect(run).toBeDefined();

    const failingExecution = new ExecutionEngine(
      db,
      {
        allocateIdentity(logicalName: string): AgentIdentity {
          throw new CnogError("AGENT_RETRY_EXHAUSTED", {
            name: logicalName,
            retries: "3",
          });
        },
        spawn(): AgentInfo {
          throw new Error("spawn should not be called");
        },
      } as never,
      lifecycle,
      memory,
      new MergeQueue(db, events, "main", tmpDir, lifecycle),
      events,
      dispatcher,
      "claude",
      "main",
      tmpDir,
    );

    failingExecution.continueRun(run!.id);

    expect(db.runs.get(run!.id)?.status).toBe("failed");
    expect(db.runs.get(run!.id)?.phase_reason).toContain("retry budget");
  });

  it("reopens failed builder work and retries from task state", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");

    const run = db.runs.latestForFeature("auth");
    expect(run).toBeDefined();

    const taskA = memory.list({ feature: "auth" }).find((issue) => issue.title === "Task A");
    expect(taskA).toBeDefined();

    const contracts = new ContractManager(db, events, tmpDir);
    const taskAContract = contracts.loadLatestForIssue(taskA!.id, "auth");
    expect(taskAContract).toBeDefined();
    contracts.accept(taskAContract!.id, "auth", "evaluator-auth");

    execution.spawnAccepted("auth");
    expect(spawnCalls).toHaveLength(1);

    const firstIdentity = spawnCalls[0].identity as AgentIdentity;
    const firstAgentName = firstIdentity.name;

    db.sessions.updateState(firstAgentName, "failed", "OOM");
    execution.handleSessionFailure(firstAgentName, "OOM");

    expect(db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]?.status).toBe("failed");
    expect(memory.get(taskA!.id)?.status).toBe("open");
    expect(memory.get(taskA!.id)?.assignee).toBeNull();

    spawnCalls = [];
    execution.continueRun(run!.id);

    expect(spawnCalls).toHaveLength(1);
    const retryIdentity = spawnCalls[0].identity as AgentIdentity;
    expect(retryIdentity.name).toBe(`${firstAgentName}-r2`);
    expect(db.executionTasks.list({ run_id: run!.id, issue_id: taskA!.id })[0]?.status).toBe("running");
  });

  it("blocks implementation evaluation when review-scope verification fails", () => {
    const runId = `run-evaluate-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.runs.create({
      id: runId,
      feature: "auth",
      plan_number: "01",
      status: "evaluate",
      phase_reason: null,
      profile: "migration-rollout",
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });

    const contracts = new ContractManager(db, events, tmpDir);
    contracts.propose({
      id: "contract-eval-a",
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
    contracts.accept("contract-eval-a", "auth", "evaluator-auth");

    const builderSessionId = `session-builder-auth-done`;
    db.sessions.create({
      id: builderSessionId,
      name: "builder-auth-done",
      logical_name: "builder-auth-done",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: issue.id,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/builder-auth-done",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth-done",
      agent_name: "builder-auth-done",
      run_id: runId,
      session_id: builderSessionId,
      task_id: issue.id,
      head_sha: "abc123",
      files_modified: null,
    });

    execution.continueRun(runId);

    expect(spawnCalls.some((call) => call.capability === "evaluator")).toBe(false);
    const scope = db.reviewScopes.activeForRun(runId);
    expect(scope).toBeDefined();
    expect(db.executionTasks.list({ run_id: runId, review_scope_id: scope!.id, kind: "verify" })[0]?.status).toBe("failed");
  });

  it("manual evaluation request also blocks on failed review-scope verification", () => {
    const runId = `run-evaluate-manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    db.runs.create({
      id: runId,
      feature: "auth",
      plan_number: "01",
      status: "build",
      phase_reason: null,
      profile: "migration-rollout",
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });
    const issue = memory.create({
      title: "Task A",
      feature: "auth",
      runId,
      planNumber: "01",
      metadata: { planTaskKey: "auth:01:00", planTaskIndex: 0 },
    });
    db.issues.update(issue.id, { status: "done", assignee: null });

    const contracts = new ContractManager(db, events, tmpDir);
    contracts.propose({
      id: "contract-eval-manual-a",
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
    contracts.accept("contract-eval-manual-a", "auth", "evaluator-auth");

    const builderSessionId = "session-builder-auth-manual";
    db.sessions.create({
      id: builderSessionId,
      name: "builder-auth-manual",
      logical_name: "builder-auth-manual",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: issue.id,
      execution_task_id: null,
      worktree_path: null,
      transcript_path: null,
      branch: "cnog/auth/builder-auth-manual",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: runId,
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth-manual",
      agent_name: "builder-auth-manual",
      run_id: runId,
      session_id: builderSessionId,
      task_id: issue.id,
      head_sha: "abc124",
      files_modified: null,
    });

    const result = execution.requestEvaluation("auth");

    expect(result).toEqual({
      status: "blocked",
      reason: "Review-scope verification failed",
    });
    expect(spawnCalls.some((call) => call.capability === "evaluator")).toBe(false);
    expect(db.runs.get(runId)?.status).toBe("evaluate");
  });
});
