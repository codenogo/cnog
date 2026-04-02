import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MailClient } from "../src/mail.js";
import { MergeQueue } from "../src/merge.js";
import { Watchdog } from "../src/watchdog.js";
import { Lifecycle } from "../src/lifecycle.js";
import { MemoryEngine } from "../src/memory.js";
import { Dispatcher } from "../src/dispatch.js";
import { ExecutionEngine } from "../src/execution.js";
import { Orchestrator } from "../src/orchestrator.js";
import { ContractManager } from "../src/contracts.js";
import { buildReviewScope } from "../src/review.js";
import type { AgentIdentity, AgentInfo } from "../src/agents.js";
import type { Capability, SprintContract } from "../src/types.js";

let db: CnogDB;
let events: EventEmitter;
let mail: MailClient;
let lifecycle: Lifecycle;
let memory: MemoryEngine;
let tmpDir: string;
let orch: Orchestrator;
let runSeq = 0;
let dispatcher: Dispatcher;
let execution: ExecutionEngine;
let spawnCalls: Array<Record<string, unknown>>;

function createTestRun(feature: string, status: string = "plan"): string {
  const id = `run-orch-${++runSeq}`;
  // Mark any existing active run for this feature as done first
  const existing = db.runs.activeForFeature(feature);
  if (existing) {
    db.runs.update(existing.id, { status: "done" });
  }
  db.runs.create({
    id, feature, plan_number: null, status, phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  db.phases.set(feature, status);
  return id;
}

function createTestSession(runId: string, name: string, feature: string, opts?: Partial<{
  capability: string; state: string; branch: string; task_id: string; execution_task_id: string; worktree_path: string;
}>): string {
  const id = `sess-${name}-${runSeq}`;
  db.sessions.create({
    id,
    name,
    logical_name: name,
    attempt: 1,
    runtime: "claude",
    capability: (opts?.capability ?? "builder") as "planner" | "builder" | "evaluator",
    feature,
    task_id: opts?.task_id ?? null,
    execution_task_id: opts?.execution_task_id ?? null,
    worktree_path: opts?.worktree_path ?? null,
    transcript_path: null,
    branch: opts?.branch ?? null,
    tmux_session: null,
    pid: null,
    state: opts?.state ?? "working",
    parent_agent: null,
    run_id: runId,
  });
  return id;
}

function createPlanFile(feature: string): void {
  const dir = join(tmpDir, "docs", "planning", "work", "features", feature);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-PLAN.json"), JSON.stringify({ schemaVersion: 3, feature, tasks: [{ name: "t1" }] }));
}

function createAcceptedContract(issueId: string, feature: string, runId: string, verifyCommands: string[] = []): SprintContract {
  const contracts = new ContractManager(db, events, tmpDir);
  const contract: SprintContract = {
    id: `contract-${issueId}`,
    taskId: issueId,
    runId,
    feature,
    agentName: `builder-${feature}`,
    acceptanceCriteria: [{ description: "Implement the task", testable: true }],
    verifyCommands,
    fileScope: [`src/${feature}.ts`],
    status: "proposed",
    proposedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
  };
  contracts.propose(contract);
  return contracts.accept(contract.id, feature, "evaluator-contracts")!;
}

async function settleVerifyTask(runId: string, logicalName: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    orch.tick();
    const task = db.executionTasks.getByLogicalName(runId, logicalName);
    if (task && (task.status === "completed" || task.status === "failed" || task.status === "blocked")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${logicalName} to settle`);
}

function createActiveEvaluationScope(feature: string, runId: string, builderName: string): string {
  const issue = memory.create({ title: `Implement ${feature}`, feature, runId });
  createAcceptedContract(issue.id, feature, runId);
  const buildTaskId = `xtask-build-${feature}-${runId}`;
  db.executionTasks.create({
    id: buildTaskId,
    run_id: runId,
    issue_id: issue.id,
    review_scope_id: null,
    parent_task_id: null,
    logical_name: `build:${issue.id}`,
    kind: "build",
    capability: "builder",
    executor: "agent",
    status: "completed",
    active_session_id: null,
    summary: "Build completed",
    output_path: `.cnog/features/${feature}/runs/${runId}/tasks/${buildTaskId}.output`,
    result_path: null,
    output_offset: 0,
    notified: 1,
    notified_at: "2026-04-01 10:00:00",
    last_error: null,
  });
  const builderSessionId = createTestSession(runId, builderName, feature, {
    capability: "builder",
    branch: `cnog/${feature}/${builderName}`,
    task_id: issue.id,
    execution_task_id: buildTaskId,
    state: "completed",
  });
  db.merges.enqueue({
    feature,
    branch: `cnog/${feature}/${builderName}`,
    agent_name: builderName,
    run_id: runId,
    session_id: builderSessionId,
    task_id: issue.id,
    head_sha: `${feature}-sha`,
    files_modified: null,
  });
  const scopeId = buildReviewScope({
    runId,
    feature,
    db,
    projectRoot: tmpDir,
  });
  db.reviewScopes.updateStatus(scopeId, "evaluating");
  return scopeId;
}

function builderCompletionPayload(opts: {
  runId: string;
  feature: string;
  executionTaskId: string;
  issueId: string;
  branch: string;
  agentName?: string;
  summary?: string;
  headSha?: string;
  filesModified?: string[];
}) {
  const agentName = opts.agentName ?? "builder-auth";
  const session = db.sessions.get(agentName);
  return {
    protocolVersion: 2 as const,
    kind: "worker_notification" as const,
    status: "completed" as const,
    summary: opts.summary ?? "Completed assigned implementation work",
    run: { id: opts.runId, feature: opts.feature },
    actor: {
      agentName,
      logicalName: session?.logical_name ?? agentName,
      attempt: session?.attempt ?? 1,
      capability: "builder" as const,
      runtime: session?.runtime ?? "claude",
      sessionId: session?.id ?? `session-${agentName}`,
    },
    task: {
      executionTaskId: opts.executionTaskId,
      logicalName: db.executionTasks.get(opts.executionTaskId)?.logical_name,
      kind: "build" as const,
      executor: "agent" as const,
      issueId: opts.issueId,
    },
    output: {
      taskLogPath: db.executionTasks.get(opts.executionTaskId)?.output_path ?? undefined,
      resultPath: db.executionTasks.get(opts.executionTaskId)?.result_path ?? undefined,
      transcriptPath: session?.transcript_path ?? undefined,
    },
    worktree: {
      path: session?.worktree_path ?? undefined,
      branch: opts.branch,
      headSha: opts.headSha ?? "abc123",
      filesModified: opts.filesModified ?? ["src/auth.ts"],
    },
    usage: {
      durationMs: 1000,
    },
    data: {
      kind: "builder_completion" as const,
      headSha: opts.headSha ?? "abc123",
      filesModified: opts.filesModified ?? ["src/auth.ts"],
    },
  };
}

function implementationReviewPayload(opts: {
  runId: string;
  feature: string;
  scopeId: string;
  scopeHash: string;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCK";
  agentName?: string;
  summary?: string;
}) {
  const agentName = opts.agentName ?? "evaluator-auth";
  const session = db.sessions.get(agentName);
  return {
    protocolVersion: 2 as const,
    kind: "worker_notification" as const,
    status: "completed" as const,
    summary: opts.summary ?? `Evaluation completed with verdict ${opts.verdict}`,
    run: { id: opts.runId, feature: opts.feature },
    actor: {
      agentName,
      logicalName: session?.logical_name ?? agentName,
      attempt: session?.attempt ?? 1,
      capability: "evaluator" as const,
      runtime: session?.runtime ?? "claude",
      sessionId: session?.id ?? `session-${agentName}`,
    },
    task: {
      executionTaskId: session?.execution_task_id ?? undefined,
      logicalName: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.logical_name : undefined,
      kind: "implementation_review" as const,
      executor: "agent" as const,
      reviewScopeId: opts.scopeId,
      scopeHash: opts.scopeHash,
    },
    output: {
      taskLogPath: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.output_path ?? undefined : undefined,
      resultPath: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.result_path ?? undefined : undefined,
      transcriptPath: session?.transcript_path ?? undefined,
    },
    usage: {
      durationMs: 1000,
    },
    data: {
      kind: "implementation_review" as const,
      scopeId: opts.scopeId,
      scopeHash: opts.scopeHash,
      verdict: opts.verdict,
      reworkPhase: opts.verdict === "BLOCK" ? "contract" : "build",
      scores: opts.verdict === "APPROVE"
        ? [
          { criterion: "functionality", score: 1, feedback: "ok" },
          { criterion: "completeness", score: 1, feedback: "ok" },
          { criterion: "code_quality", score: 1, feedback: "ok" },
          { criterion: "test_coverage", score: 1, feedback: "ok" },
        ]
        : [
          { criterion: "functionality", score: 0.5, feedback: "needs work" },
          { criterion: "completeness", score: 0.8, feedback: "mostly there" },
          { criterion: "code_quality", score: 0.8, feedback: "acceptable" },
          { criterion: "test_coverage", score: 0.8, feedback: "acceptable" },
        ],
    },
  };
}

function contractReviewPayload(opts: {
  runId: string;
  feature: string;
  decisions: Array<{ contractId: string; decision: "ACCEPT" | "REJECT"; notes?: string }>;
  agentName?: string;
  summary?: string;
}) {
  const agentName = opts.agentName ?? "evaluator-contracts";
  const session = db.sessions.get(agentName);
  return {
    protocolVersion: 2 as const,
    kind: "worker_notification" as const,
    status: "completed" as const,
    summary: opts.summary ?? "Contract review completed",
    run: { id: opts.runId, feature: opts.feature },
    actor: {
      agentName,
      logicalName: session?.logical_name ?? agentName,
      attempt: session?.attempt ?? 1,
      capability: "evaluator" as const,
      runtime: session?.runtime ?? "claude",
      sessionId: session?.id ?? `session-${agentName}`,
    },
    task: {
      executionTaskId: session?.execution_task_id ?? undefined,
      logicalName: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.logical_name : undefined,
      kind: "contract_review" as const,
      executor: "agent" as const,
    },
    output: {
      taskLogPath: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.output_path ?? undefined : undefined,
      transcriptPath: session?.transcript_path ?? undefined,
    },
    usage: {
      durationMs: 1000,
    },
    data: {
      kind: "contract_review" as const,
      contracts: opts.decisions,
    },
  };
}

function genericFailurePayload(opts: {
  runId: string;
  feature: string;
  role: Capability;
  summary: string;
  agentName: string;
}) {
  const session = db.sessions.get(opts.agentName);
  return {
    protocolVersion: 2 as const,
    kind: "worker_notification" as const,
    status: "failed" as const,
    summary: opts.summary,
    run: { id: opts.runId, feature: opts.feature },
    actor: {
      agentName: opts.agentName,
      logicalName: session?.logical_name ?? opts.agentName,
      attempt: session?.attempt ?? 1,
      capability: opts.role,
      runtime: session?.runtime ?? "claude",
      sessionId: session?.id ?? `session-${opts.agentName}`,
    },
    task: {
      executionTaskId: session?.execution_task_id ?? undefined,
      logicalName: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.logical_name : undefined,
      kind: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.kind as "build" | "contract_review" | "implementation_review" | "merge" | "verify" : undefined,
      executor: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.executor as "agent" | "shell" | "system" : undefined,
      issueId: session?.task_id ?? undefined,
    },
    output: {
      taskLogPath: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.output_path ?? undefined : undefined,
      transcriptPath: session?.transcript_path ?? undefined,
    },
    usage: {
      durationMs: 1000,
    },
    data: {
      kind: "generic_completion" as const,
      role: opts.role,
    },
  };
}

function escalationPayload(opts: {
  runId: string;
  feature: string;
  summary: string;
  agentName?: string;
}) {
  const agentName = opts.agentName ?? "builder-1";
  const session = db.sessions.get(agentName);
  return {
    protocolVersion: 2 as const,
    kind: "worker_notification" as const,
    status: "blocked" as const,
    summary: opts.summary,
    run: { id: opts.runId, feature: opts.feature },
    actor: {
      agentName,
      logicalName: session?.logical_name ?? agentName,
      attempt: session?.attempt ?? 1,
      capability: "builder" as const,
      runtime: session?.runtime ?? "claude",
      sessionId: session?.id ?? `session-${agentName}`,
    },
    task: {
      executionTaskId: session?.execution_task_id ?? undefined,
      logicalName: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.logical_name : undefined,
      issueId: session?.task_id ?? undefined,
    },
    output: {
      taskLogPath: session?.execution_task_id ? db.executionTasks.get(session.execution_task_id)?.output_path ?? undefined : undefined,
      transcriptPath: session?.transcript_path ?? undefined,
    },
    data: {
      kind: "escalation" as const,
      role: "builder" as const,
      code: "external_blocker" as const,
      evidence: ["Cannot proceed without external fix"],
      requestedAction: "Unblock the dependency",
    },
  };
}

/**
 * Helper: set up a run through plan -> contract -> build -> evaluate
 * by creating necessary artifacts and advancing.
 */
function setupRunAtPhase(feature: string, targetPhase: string): string {
  const runId = createTestRun(feature, targetPhase);
  return runId;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-orch-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  mail = new MailClient(db);
  lifecycle = new Lifecycle(db, events, tmpDir);
  memory = new MemoryEngine(db);
  runSeq = 0;
  spawnCalls = [];
  const mergeQueue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
  const watchdog = new Watchdog(db, events, mail);
  dispatcher = new Dispatcher(db, lifecycle, memory, events, tmpDir);
  execution = new ExecutionEngine(
    db,
    {
      allocateIdentity(logicalName: string) {
        return { logicalName, attempt: 1, name: logicalName };
      },
      spawn(opts: Record<string, unknown>): AgentInfo {
        spawnCalls.push(opts);
        const identity = opts.identity as AgentIdentity;
        return {
          id: `agent-${identity.name}`,
          name: identity.name,
          runtime: String(opts.runtimeId),
          capability: opts.capability as Capability,
          feature: String(opts.feature),
          state: "working",
          branch: (opts.baseBranch as string | undefined) ?? null,
          worktreePath: "/tmp/worktree",
          transcriptPath: null,
          tmuxSession: "cnog-test",
          pid: 123,
          parentAgent: null,
          startedAt: new Date().toISOString(),
          lastHeartbeat: null,
          error: null,
        };
      },
    } as never,
    lifecycle,
    memory,
    mergeQueue,
    events,
    dispatcher,
    "claude",
    "main",
    tmpDir,
  );
  orch = new Orchestrator(
    db,
    events,
    mail,
    mergeQueue,
    watchdog,
    lifecycle,
    undefined,
    { execution },
  );
});

afterEach(() => {
  orch.stop();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Orchestrator", () => {
  it("tick returns status snapshot", () => {
    const status = orch.tick();
    expect(status.activeAgents).toBe(0);
    expect(status.pendingMerges).toBe(0);
    expect(status.unreadMail).toBe(0);
    expect(status.tick).toBe(1);
  });

  it("tick count increments", () => {
    orch.tick();
    const status = orch.tick();
    expect(status.tick).toBe(2);
  });

  it("handles completed builder notifications by enqueueing merge", () => {
    const runId = createTestRun("auth", "build");
    db.executionTasks.create({
      id: "xtask-worker-done",
      run_id: runId,
      issue_id: null,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:auth",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-worker-done.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    db.issues.create({
      id: "cn-auth-worker-done",
      title: "Implement auth",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-auth",
      feature: "auth",
      run_id: runId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.update("xtask-worker-done", { issue_id: "cn-auth-worker-done", logical_name: "build:cn-auth-worker-done" });
    // Create a session so the agent exists
    createTestSession(runId, "builder-auth", "auth", {
      task_id: "cn-auth-worker-done",
      branch: "cnog/auth/builder-auth",
      execution_task_id: "xtask-worker-done",
    });

    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: builderCompletionPayload({
        runId,
        feature: "auth",
        executionTaskId: "xtask-worker-done",
        issueId: "cn-auth-worker-done",
        branch: "cnog/auth/builder-auth",
      }),
    });

    orch.tick();

    // Merge was enqueued and then processed (no real git, so it fails/conflicts).
    // Check the merge queue has an entry (any status — it's been processed already).
    const allMerges = db.db
      .prepare("SELECT * FROM merge_queue WHERE branch = ?")
      .all("cnog/auth/builder-auth") as Array<{ branch: string }>;
    expect(allMerges).toHaveLength(1);

    // Agent should be marked completed
    const session = db.sessions.get("builder-auth");
    expect(session!.state).toBe("completed");
    expect(db.executionTasks.get("xtask-worker-done")?.status).toBe("completed");
  });

  it("runs post-build verification before enqueueing merge work", async () => {
    const runId = createTestRun("auth", "build");
    const issue = memory.create({
      title: "Implement auth",
      feature: "auth",
      runId,
    });
    createAcceptedContract(issue.id, "auth", runId, ['node -e "process.exit(0)"']);
    db.executionTasks.create({
      id: "xtask-worker-done-verify",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issue.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-worker-done-verify.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    memory.claim(issue.id, "builder-auth");
    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: issue.id,
      execution_task_id: "xtask-worker-done-verify",
      worktree_path: tmpDir,
    });

    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: builderCompletionPayload({
        runId,
        feature: "auth",
        executionTaskId: "xtask-worker-done-verify",
        issueId: issue.id,
        branch: "cnog/auth/builder-auth",
      }),
    });

    orch.tick();
    await settleVerifyTask(runId, `verify:${issue.id}:00`);

    const verifyTask = db.executionTasks.getByLogicalName(runId, `verify:${issue.id}:00`);
    expect(verifyTask?.status).toBe("completed");
    expect(db.executionTasks.get("xtask-worker-done-verify")?.status).toBe("completed");
    expect(memory.get(issue.id)?.status).toBe("done");
    const allMerges = db.db
      .prepare("SELECT * FROM merge_queue WHERE branch = ?")
      .all("cnog/auth/builder-auth") as Array<{ branch: string; head_sha: string; files_modified: string | null }>;
    expect(allMerges).toHaveLength(1);
    expect(allMerges[0].head_sha).toBe("abc123");
    expect(JSON.parse(allMerges[0].files_modified ?? "[]")).toEqual(["src/auth.ts"]);
  });

  it("reopens the issue when post-build verification fails", async () => {
    const runId = createTestRun("auth", "build");
    const issue = memory.create({
      title: "Implement auth",
      feature: "auth",
      runId,
    });
    createAcceptedContract(issue.id, "auth", runId, ['node -e "process.stderr.write(\'boom\'); process.exit(2)"']);
    db.executionTasks.create({
      id: "xtask-worker-done-verify-fail",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issue.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-worker-done-verify-fail.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    memory.claim(issue.id, "builder-auth");
    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: issue.id,
      execution_task_id: "xtask-worker-done-verify-fail",
      worktree_path: tmpDir,
    });

    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: builderCompletionPayload({
        runId,
        feature: "auth",
        executionTaskId: "xtask-worker-done-verify-fail",
        issueId: issue.id,
        branch: "cnog/auth/builder-auth",
      }),
    });

    orch.tick();
    await settleVerifyTask(runId, `verify:${issue.id}:00`);

    const verifyTask = db.executionTasks.getByLogicalName(runId, `verify:${issue.id}:00`);
    expect(verifyTask?.status).toBe("failed");
    expect(db.executionTasks.get("xtask-worker-done-verify-fail")?.status).toBe("failed");
    expect(memory.get(issue.id)?.status).toBe("open");
    expect(memory.get(issue.id)?.assignee).toBeNull();
    const allMerges = db.db
      .prepare("SELECT * FROM merge_queue WHERE branch = ?")
      .all("cnog/auth/builder-auth") as Array<{ branch: string }>;
    expect(allMerges).toHaveLength(0);
  });

  it("marks the issue done and advances the feature to evaluate when the final task completes", () => {
    const runId = createTestRun("auth", "build");

    const issue = memory.create({
      title: "Implement auth",
      feature: "auth",
      runId,
    });
    memory.claim(issue.id, "builder-auth");
    db.executionTasks.create({
      id: "xtask-build-auth-final",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issue.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-build-auth-final.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });

    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: issue.id,
      execution_task_id: "xtask-build-auth-final",
    });

    const mergeQueue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    const watchdog = new Watchdog(db, events, mail);
    const orchestrator = new Orchestrator(
      db,
      events,
      mail,
      mergeQueue,
      watchdog,
      lifecycle,
      undefined,
      { execution },
    );

    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: builderCompletionPayload({
        runId,
        feature: "auth",
        executionTaskId: "xtask-build-auth-final",
        issueId: issue.id,
        branch: "cnog/auth/builder-auth",
      }),
    });

    orchestrator.tick();

    expect(memory.get(issue.id)?.status).toBe("done");
    expect(lifecycle.getFeaturePhase("auth")).toBe("evaluate");
    expect(spawnCalls.some((call) => call.capability === "evaluator")).toBe(true);
  });

  it("dispatches newly unblocked work after a dependency finishes", () => {
    const runId = createTestRun("auth", "build");

    const first = memory.create({ title: "first", feature: "auth", runId });
    const second = memory.create({ title: "second", feature: "auth", runId });
    memory.addDep(second.id, first.id);
    memory.claim(first.id, "builder-auth");

    db.executionTasks.create({
      id: "xtask-dispatch-auth",
      run_id: runId,
      issue_id: first.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${first.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-dispatch-auth.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: first.id,
      execution_task_id: "xtask-dispatch-auth",
    });

    const dispatchCalls: string[] = [];
    const mergeQueue = new MergeQueue(db, events, "main", tmpDir, lifecycle);
    const watchdog = new Watchdog(db, events, mail);
    const orchestrator = new Orchestrator(
      db,
      events,
      mail,
      mergeQueue,
      watchdog,
      lifecycle,
      undefined,
      {
        execution: {
          handleWorkerDone() {
            dispatchCalls.push("auth");
          },
        } as never,
      },
    );

    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: builderCompletionPayload({
        runId,
        feature: "auth",
        executionTaskId: "xtask-dispatch-auth",
        issueId: first.id,
        branch: "cnog/auth/builder-auth",
      }),
    });

    orchestrator.tick();

    expect(dispatchCalls).toEqual(["auth"]);
  });

  it("handles blocked escalations by stalling the session and freeing task WIP", () => {
    const runId = createTestRun("auth", "build");
    const issue = memory.create({ title: "Implement auth", feature: "auth", runId });
    db.executionTasks.create({
      id: "xtask-builder-1",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issue.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-builder-1.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    const sessionId = createTestSession(runId, "builder-1", "auth", {
      task_id: issue.id,
      execution_task_id: "xtask-builder-1",
    });
    db.executionTasks.update("xtask-builder-1", { active_session_id: sessionId });
    mail.send({
      fromAgent: "builder-1",
      toAgent: "orchestrator",
      subject: "blocked on npm",
      type: "worker_notification",
      payload: escalationPayload({
        runId,
        feature: "auth",
        summary: "blocked on npm",
      }),
    });

    orch.tick();

    const events = db.events.query({ source: "orchestrator" });
    const escalation = events.find((e) => e.event_type === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation!.message).toContain("builder-1");
    expect(db.sessions.get("builder-1")?.state).toBe("stalled");
    expect(db.sessions.get("builder-1")?.error).toBe("blocked on npm");
    expect(db.executionTasks.get("xtask-builder-1")).toMatchObject({
      status: "blocked",
      active_session_id: null,
      summary: "Blocked: blocked on npm",
      last_error: "external_blocker",
    });
  });

  it("handles failed worker notifications by marking agent failed", () => {
    const runId = createTestRun("auth", "build");
    const issue = memory.create({ title: "Implement auth", feature: "auth", runId });
    db.executionTasks.create({
      id: "xtask-error",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:error",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-error.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    createTestSession(runId, "agent-1", "auth", { task_id: issue.id, execution_task_id: "xtask-error" });
    memory.claim(issue.id, "agent-1");

    mail.send({
      fromAgent: "agent-1",
      toAgent: "orchestrator",
      subject: "crash",
      type: "worker_notification",
      payload: genericFailurePayload({
        runId,
        feature: "auth",
        role: "builder",
        summary: "OOM error",
        agentName: "agent-1",
      }),
    });

    orch.tick();

    const session = db.sessions.get("agent-1");
    expect(session!.state).toBe("failed");
    expect(session!.error).toBe("OOM error");
    expect(db.executionTasks.get("xtask-error")?.status).toBe("failed");
    expect(db.issues.get(issue.id)?.status).toBe("open");
    expect(db.issues.get(issue.id)?.assignee).toBeNull();
  });

  it("handles worker_notification with review verdict", () => {
    const runId = createTestRun("auth", "evaluate");
    db.executionTasks.create({
      id: "xtask-eval",
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
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-eval.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    createTestSession(runId, "evaluator-auth", "auth", {
      capability: "evaluator",
      execution_task_id: "xtask-eval",
    });
    const scopeId = createActiveEvaluationScope("auth", runId, "builder-auth-result");
    const activeScope = db.reviewScopes.get(scopeId)!;

    mail.send({
      fromAgent: "evaluator-auth",
      toAgent: "orchestrator",
      subject: "review: APPROVE",
      type: "worker_notification",
      payload: implementationReviewPayload({
        runId,
        feature: "auth",
        scopeId,
        scopeHash: activeScope.scope_hash,
        verdict: "APPROVE",
      }),
    });

    orch.tick();

    const scope = db.reviewScopes.get(scopeId);
    expect(scope?.verdict).toBe("APPROVE");
    expect(db.executionTasks.get("xtask-eval")?.status).toBe("completed");
    expect(db.executionTasks.get("xtask-eval")?.result_path).toContain("grading-report");
    // The approval advances into merge, then the same tick processes the merge
    // queue against a temp repo with no real branch state and falls back to build.
    expect(db.runs.get(runId)?.status).toBe("build");
  });

  it("marks malformed evaluator results as protocol violations", () => {
    const runId = createTestRun("billing", "evaluate");
    createTestSession(runId, "evaluator-billing", "billing", { capability: "evaluator" });
    createActiveEvaluationScope("billing", runId, "builder-billing-result");

    db.messages.send({
      from_agent: "evaluator-billing",
      to_agent: "orchestrator",
      subject: "review: REQUEST_CHANGES",
      body: null,
      type: "worker_notification",
      priority: "high",
      thread_id: null,
      payload: JSON.stringify({ verdict: "REQUEST_CHANGES" }),
      run_id: runId,
    });

    orch.tick();

    expect(db.sessions.get("evaluator-billing")?.state).toBe("failed");
    const protocolViolation = db.events.query({ source: "orchestrator" })
      .find((event) => event.event_type === "protocol_violation");
    expect(protocolViolation).toBeDefined();
  });

  it("rejects builder sessions that try to submit implementation review verdicts", () => {
    const runId = createTestRun("auth", "evaluate");
    const issue = memory.create({ title: "Implement auth", feature: "auth", runId });
    db.executionTasks.create({
      id: "xtask-build-auth-review",
      run_id: runId,
      issue_id: issue.id,
      review_scope_id: null,
      parent_task_id: null,
      logical_name: `build:${issue.id}`,
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Builder running",
      output_path: `.cnog/features/auth/runs/${runId}/tasks/xtask-build-auth-review.output`,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    const builderSessionId = createTestSession(runId, "builder-auth-review", "auth", {
      capability: "builder",
      task_id: issue.id,
      execution_task_id: "xtask-build-auth-review",
    });
    db.executionTasks.update("xtask-build-auth-review", { active_session_id: builderSessionId });
    const scopeId = createActiveEvaluationScope("auth", runId, "builder-auth-review-source");
    const scope = db.reviewScopes.get(scopeId)!;

    const payload = implementationReviewPayload({
      runId,
      feature: "auth",
      scopeId,
      scopeHash: scope.scope_hash,
      verdict: "APPROVE",
      agentName: "builder-auth-review",
      summary: "Self-approved review",
    });
    payload.actor.capability = "builder";
    payload.task.executionTaskId = "xtask-build-auth-review";
    payload.task.logicalName = db.executionTasks.get("xtask-build-auth-review")?.logical_name;
    payload.task.kind = "build";
    payload.task.reviewScopeId = scopeId;
    payload.task.scopeHash = scope.scope_hash;

    mail.send({
      fromAgent: "builder-auth-review",
      toAgent: "orchestrator",
      subject: "review: APPROVE",
      type: "worker_notification",
      payload,
    });

    orch.tick();

    expect(db.sessions.get("builder-auth-review")?.state).toBe("failed");
    expect(db.executionTasks.get("xtask-build-auth-review")?.status).toBe("failed");
    expect(db.issues.get(issue.id)?.status).toBe("open");
    expect(db.reviewScopes.get(scopeId)?.verdict).toBeNull();
    const protocolViolation = db.events.query({ source: "orchestrator" })
      .find((event) => event.event_type === "protocol_violation");
    expect(protocolViolation?.message).toContain("implementation review requires evaluator capability");
  });

  it("rejects planner sessions that try to submit contract review verdicts", () => {
    const runId = createTestRun("contracts", "contract");
    createTestSession(runId, "planner-contracts", "contracts", { capability: "planner" });
    const issue = memory.create({ title: "Define contract", feature: "contracts", runId });
    createAcceptedContract(issue.id, "contracts", runId);

    const session = db.sessions.get("planner-contracts")!;
    mail.send({
      fromAgent: "planner-contracts",
      toAgent: "orchestrator",
      subject: "contracts reviewed",
      type: "worker_notification",
      payload: {
        protocolVersion: 2,
        kind: "worker_notification",
        status: "completed",
        summary: "Attempted contract review",
        run: { id: runId, feature: "contracts" },
        actor: {
          agentName: "planner-contracts",
          logicalName: session.logical_name,
          attempt: session.attempt,
          capability: "planner",
          runtime: session.runtime,
          sessionId: session.id,
        },
        task: {},
        output: {},
        usage: { durationMs: 1000 },
        data: {
          kind: "contract_review",
          contracts: [{ contractId: `contract-${issue.id}`, decision: "ACCEPT" }],
        },
      },
    });

    orch.tick();

    expect(db.sessions.get("planner-contracts")?.state).toBe("failed");
    const protocolViolation = db.events.query({ source: "orchestrator" })
      .find((event) => event.event_type === "protocol_violation");
    expect(protocolViolation?.message).toContain("contract review requires evaluator capability");
  });

  it("applies contract review results and leaves the run in contract for rejected contracts", () => {
    const runId = createTestRun("contracts", "contract");
    createTestSession(runId, "evaluator-contracts", "contracts", { capability: "evaluator" });
    const issue = memory.create({ title: "Define contract", feature: "contracts", runId });
    const contractDir = join(tmpDir, ".cnog", "features", "contracts", "runs", runId);
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(
      join(contractDir, "contract-a.v1.json"),
      JSON.stringify({
        id: "contract-a",
        taskId: issue.id,
        runId,
        feature: "contracts",
        agentName: "builder-contracts",
        acceptanceCriteria: [{ description: "Do the thing", testable: true }],
        verifyCommands: ["npm test"],
        fileScope: ["src/contracts.ts"],
        status: "pending_review",
        proposedAt: new Date().toISOString(),
        reviewedBy: null,
        reviewedAt: null,
        reviewNotes: null,
      }, null, 2),
    );
    db.artifacts.create({
      id: "art-contract-a-v1",
      run_id: runId,
      feature: "contracts",
      type: "contract",
      path: join(".cnog", "features", "contracts", "runs", runId, "contract-a.v1.json"),
      hash: "hash-contract-a",
      issue_id: issue.id,
      session_id: null,
      review_scope_id: null,
    });

    mail.send({
      fromAgent: "evaluator-contracts",
      toAgent: "orchestrator",
      subject: "contract review complete",
      type: "worker_notification",
      payload: contractReviewPayload({
        runId,
        feature: "contracts",
        summary: "Contract review completed",
        decisions: [
          { contractId: "contract-a", decision: "REJECT", notes: "Need tighter scope" },
        ],
      }),
    });

    orch.tick();

    expect(db.runs.get(runId)?.status).toBe("contract");
    const latestContract = db.artifacts.listByIssue(issue.id).at(-1);
    expect(latestContract?.type).toBe("contract");
  });

  it("ignores late evaluator verdicts once the run has left evaluate", () => {
    const runId = createTestRun("auth", "build");
    createTestSession(runId, "evaluator-auth", "auth", { capability: "evaluator" });

    mail.send({
      fromAgent: "evaluator-auth",
      toAgent: "orchestrator",
      subject: "review: APPROVE",
      type: "worker_notification",
      payload: implementationReviewPayload({
        runId,
        feature: "auth",
        scopeId: "scope-unused",
        scopeHash: "hash-unused",
        verdict: "APPROVE",
      }),
    });

    orch.tick();

    // Phase is build, not evaluate — verdict should be ignored
    expect(db.phases.get("auth")?.review_verdict).toBeFalsy();
    expect(db.sessions.get("evaluator-auth")?.state).toBe("completed");
  });
});
