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
  capability: string; state: string; branch: string; task_id: string;
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
    worktree_path: null,
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

function createAcceptedContract(issueId: string, feature: string, runId: string): SprintContract {
  const contracts = new ContractManager(db, events, tmpDir);
  const contract: SprintContract = {
    id: `contract-${issueId}`,
    taskId: issueId,
    runId,
    feature,
    agentName: `builder-${feature}`,
    acceptanceCriteria: [{ description: "Implement the task", testable: true }],
    verifyCommands: [],
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

function createActiveEvaluationScope(feature: string, runId: string, builderName: string): string {
  const issue = memory.create({ title: `Implement ${feature}`, feature, runId });
  createAcceptedContract(issue.id, feature, runId);
  const builderSessionId = createTestSession(runId, builderName, feature, {
    capability: "builder",
    branch: `cnog/${feature}/${builderName}`,
    task_id: issue.id,
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

  it("handles worker_done message by enqueueing merge", () => {
    const runId = createTestRun("auth", "build");

    // Create a session so the agent exists
    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
    });

    // Send worker_done from builder
    mail.send({
      fromAgent: "builder-auth",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_done",
      payload: {
        feature: "auth",
        branch: "cnog/auth/builder-auth",
        head_sha: "abc123",
        files_modified: ["src/auth.ts"],
      },
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
  });

  it("marks the issue done and advances the feature to evaluate when the final task completes", () => {
    const runId = createTestRun("auth", "build");

    const issue = memory.create({
      title: "Implement auth",
      feature: "auth",
      runId,
    });
    memory.claim(issue.id, "builder-auth");

    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: issue.id,
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
      type: "worker_done",
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

    createTestSession(runId, "builder-auth", "auth", {
      branch: "cnog/auth/builder-auth",
      task_id: first.id,
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
      type: "worker_done",
    });

    orchestrator.tick();

    expect(dispatchCalls).toEqual(["auth"]);
  });

  it("handles escalation message by logging event", () => {
    mail.send({
      fromAgent: "builder-1",
      toAgent: "orchestrator",
      subject: "blocked on npm",
      body: "Cannot install deps",
      type: "escalation",
    });

    orch.tick();

    const events = db.events.query({ source: "orchestrator" });
    const escalation = events.find((e) => e.event_type === "escalation");
    expect(escalation).toBeDefined();
    expect(escalation!.message).toContain("builder-1");
  });

  it("handles error message by marking agent failed", () => {
    const runId = createTestRun("auth", "build");
    createTestSession(runId, "agent-1", "auth");

    mail.send({
      fromAgent: "agent-1",
      toAgent: "orchestrator",
      subject: "crash",
      body: "OOM error",
      type: "error",
    });

    orch.tick();

    const session = db.sessions.get("agent-1");
    expect(session!.state).toBe("failed");
    expect(session!.error).toBe("OOM error");
  });

  it("handles result message with review verdict", () => {
    const runId = createTestRun("auth", "evaluate");
    createTestSession(runId, "evaluator-auth", "auth", { capability: "evaluator" });
    const scopeId = createActiveEvaluationScope("auth", runId, "builder-auth-result");

    mail.send({
      fromAgent: "evaluator-auth",
      toAgent: "orchestrator",
      subject: "review: APPROVE",
      type: "result",
      payload: { verdict: "APPROVE" },
    });

    orch.tick();

    const scope = db.reviewScopes.get(scopeId);
    expect(scope?.verdict).toBe("APPROVE");
    // The approval advances into merge, then the same tick processes the merge
    // queue against a temp repo with no real branch state and falls back to build.
    expect(db.runs.get(runId)?.status).toBe("build");
  });

  it("extracts verdict from subject when payload missing", () => {
    const runId = createTestRun("billing", "evaluate");
    createTestSession(runId, "evaluator-billing", "billing", { capability: "evaluator" });
    const scopeId = createActiveEvaluationScope("billing", runId, "builder-billing-result");

    mail.send({
      fromAgent: "evaluator-billing",
      toAgent: "orchestrator",
      subject: "review: REQUEST_CHANGES",
      type: "result",
    });

    orch.tick();

    const scope = db.reviewScopes.get(scopeId);
    expect(scope?.verdict).toBe("REQUEST_CHANGES");
    expect(db.runs.get(runId)?.status).toBe("build");
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
      type: "result",
      payload: {
        kind: "contract_review",
        contracts: [
          { contractId: "contract-a", decision: "REJECT", notes: "Need tighter scope" },
        ],
      },
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
      type: "result",
      payload: { verdict: "APPROVE" },
    });

    orch.tick();

    // Phase is build, not evaluate — verdict should be ignored
    expect(db.phases.get("auth")?.review_verdict).toBeFalsy();
    expect(db.sessions.get("evaluator-auth")?.state).toBe("completed");
  });
});
