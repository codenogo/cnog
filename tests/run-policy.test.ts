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
      worktree_path: null,
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
