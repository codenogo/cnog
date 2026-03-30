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
        return {
          id: "agent-id",
          name: identity.name,
          runtime: String(opts.runtimeId),
          capability: opts.capability as Capability,
          feature: String(opts.feature),
          state: "working",
          branch: (opts.baseBranch as string | undefined) ?? null,
          worktreePath: "/tmp/worktree",
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

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].verifyCommands).toContain("npx tsc --noEmit");

    memory.done(taskA!.id, "builder-auth");
    db.sessions.create({
      id: "session-a",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: taskA!.id,
      worktree_path: "/tmp/worktree-a",
      branch: "cnog/auth/builder-auth",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: run!.id,
    });

    spawnCalls = [];
    dispatcher.dispatchFeature("auth");
    expect(execution.spawnAccepted("auth")).toEqual([]);

    const taskBContract = contracts.loadLatestForIssue(taskB!.id, "auth");
    expect(taskBContract?.status).toBe("pending_review");
    contracts.accept(taskBContract!.id, "auth", "evaluator-auth");

    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].taskId).toBe(taskB!.id);
    expect(spawnCalls[0].baseBranch).toBe("cnog/auth/builder-auth");
    expect(spawnCalls[0].seedBranches).toEqual([]);
    expect(spawnCalls[0].verifyCommands).toContain("npx tsc --noEmit");
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
    db.sessions.create({
      id: "session-retry-1",
      name: firstAgentName,
      logical_name: firstAgentName,
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: taskA!.id,
      worktree_path: "/tmp/worktree-a",
      branch: "cnog/auth/retry-a",
      tmux_session: null,
      pid: null,
      state: "completed",
      parent_agent: null,
      run_id: run!.id,
    });
    db.issues.update(taskA!.id, { status: "open", assignee: null });

    spawnCalls = [];
    execution.spawnAccepted("auth");

    expect(spawnCalls).toHaveLength(1);
    const retryIdentity = spawnCalls[0].identity as AgentIdentity;
    expect(retryIdentity.logicalName).toBe(firstAgentName);
    expect(retryIdentity.attempt).toBe(2);
    expect(retryIdentity.name).toBe(`${firstAgentName}-r2`);
  });

  it("spawns an evaluator for pending contracts before builders start", () => {
    dispatcher.dispatchFeature("auth", "migration-rollout");

    const results = execution.spawnAccepted("auth", "migration-rollout");

    expect(results.some((result) => result.status === "spawned")).toBe(true);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].capability).toBe("evaluator");
    expect(String(spawnCalls[0].completionCommand)).toContain('"kind":"contract_review"');
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
});
