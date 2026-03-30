import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  initiateHandoff,
  resumeFromHandoff,
  completeHandoff,
  loadHandoffs,
  loadProgressArtifact,
  type CheckpointSelector,
} from "../src/checkpoint.js";
import type { SessionCheckpoint } from "../src/types.js";

let tmpDir: string;
let db: CnogDB;
const RUN_ID = "run-checkpoint-auth";
const FEATURE = "auth";
const LOGICAL_NAME = "builder-auth";

function selector(): CheckpointSelector {
  return {
    runId: RUN_ID,
    feature: FEATURE,
    logicalName: LOGICAL_NAME,
  };
}

function makeCheckpoint(overrides?: Partial<SessionCheckpoint>): SessionCheckpoint {
  return {
    agentName: "builder-auth-r1",
    logicalName: LOGICAL_NAME,
    runId: RUN_ID,
    feature: FEATURE,
    taskId: "cn-abc123",
    sessionId: "session-001",
    timestamp: new Date().toISOString(),
    progressSummary: "Implemented auth models and JWT validation",
    filesModified: ["src/auth.ts", "tests/auth.test.ts"],
    currentBranch: "cnog/auth/builder-auth-r1",
    pendingWork: "Add refresh token endpoint",
    verifyResults: { "npm test": true, "npx tsc --noEmit": true },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-checkpoint-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  db.runs.create({
    id: RUN_ID,
    feature: FEATURE,
    plan_number: null,
    status: "build",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  // Create prerequisite rows for FK constraints on artifacts
  db.issues.create({
    id: "cn-abc123",
    title: "checkpoint test task",
    description: null,
    issue_type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    feature: FEATURE,
    run_id: RUN_ID,
    plan_number: null,
    phase: null,
    parent_id: null,
    metadata: null,
  });
  db.sessions.create({
    id: "session-001",
    name: "builder-auth-r1",
    logical_name: LOGICAL_NAME,
    attempt: 1,
    runtime: "claude",
    capability: "builder",
    feature: FEATURE,
    task_id: null,
    worktree_path: null,
    branch: "cnog/auth/builder-auth-r1",
    tmux_session: null,
    pid: null,
    state: "working",
    parent_agent: null,
    run_id: RUN_ID,
  });
  // Additional sessions used in handoff tests
  db.sessions.create({
    id: "s1",
    name: "builder-auth-s1",
    logical_name: LOGICAL_NAME,
    attempt: 2,
    runtime: "claude",
    capability: "builder",
    feature: FEATURE,
    task_id: null,
    worktree_path: null,
    branch: "cnog/auth/builder-auth-s1",
    tmux_session: null,
    pid: null,
    state: "working",
    parent_agent: null,
    run_id: RUN_ID,
  });
  db.sessions.create({
    id: "s2",
    name: "builder-auth-s2",
    logical_name: LOGICAL_NAME,
    attempt: 3,
    runtime: "claude",
    capability: "builder",
    feature: FEATURE,
    task_id: null,
    worktree_path: null,
    branch: "cnog/auth/builder-auth-s2",
    tmux_session: null,
    pid: null,
    state: "working",
    parent_agent: null,
    run_id: RUN_ID,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint CRUD", () => {
  it("saves and loads a checkpoint by run and logical name", () => {
    const cp = makeCheckpoint();
    saveCheckpoint(cp, db, tmpDir);

    const loaded = loadCheckpoint(db, selector(), tmpDir);
    expect(loaded).toBeDefined();
    expect(loaded!.agentName).toBe("builder-auth-r1");
    expect(loaded!.logicalName).toBe(LOGICAL_NAME);
    expect(loaded!.progressSummary).toContain("auth models");
    expect(loaded!.filesModified).toHaveLength(2);
    expect(db.artifacts.listByRun(RUN_ID, "checkpoint")).toHaveLength(1);
  });

  it("returns null for missing checkpoint", () => {
    expect(loadCheckpoint(db, selector(), tmpDir)).toBeNull();
  });

  it("clears a checkpoint without deleting artifact history", () => {
    saveCheckpoint(makeCheckpoint(), db, tmpDir);
    clearCheckpoint(db, selector(), tmpDir);
    expect(loadCheckpoint(db, selector(), tmpDir)).toBeNull();
    expect(db.artifacts.listByRun(RUN_ID, "checkpoint")).toHaveLength(2);
  });

  it("renders progress from the latest active checkpoint artifact", () => {
    saveCheckpoint(makeCheckpoint(), db, tmpDir);
    const progress = loadProgressArtifact(db, selector(), tmpDir);
    expect(progress).toBeDefined();
    expect(progress).toContain(`# Progress: ${LOGICAL_NAME}`);
    expect(progress).toContain("auth models");
    expect(progress).toContain("src/auth.ts");
    expect(progress).toContain("Pending work");
    expect(progress).toContain("refresh token");
  });
});

describe("handoff management", () => {
  it("initiates a handoff and records it as a checkpoint artifact", () => {
    const cp = makeCheckpoint();
    const handoff = initiateHandoff(cp, "manual", db, tmpDir);

    expect(handoff.fromSessionId).toBe("session-001");
    expect(handoff.toSessionId).toBeNull();
    expect(handoff.reason).toBe("manual");

    const handoffs = loadHandoffs(db, selector(), tmpDir);
    expect(handoffs).toHaveLength(1);
    expect(db.artifacts.listByRun(RUN_ID, "checkpoint")).toHaveLength(1);
  });

  it("resumes from pending handoff using logical identity", () => {
    const cp = makeCheckpoint();
    initiateHandoff(cp, "compaction", db, tmpDir);

    const pending = resumeFromHandoff(db, selector(), tmpDir);
    expect(pending).toBeDefined();
    expect(pending!.fromSessionId).toBe("session-001");
    expect(pending!.checkpoint.pendingWork).toContain("refresh token");
  });

  it("returns null when no pending handoff", () => {
    expect(resumeFromHandoff(db, selector(), tmpDir)).toBeNull();
  });

  it("completes a handoff and clears pending resume state", () => {
    const cp = makeCheckpoint();
    initiateHandoff(cp, "crash", db, tmpDir);

    completeHandoff(db, selector(), "session-001", "session-002", tmpDir);

    const handoffs = loadHandoffs(db, selector(), tmpDir);
    expect(handoffs[0].toSessionId).toBe("session-002");
    expect(loadCheckpoint(db, selector(), tmpDir)).toBeNull();
    expect(resumeFromHandoff(db, selector(), tmpDir)).toBeNull();
  });

  it("tracks multiple handoffs across concrete retry sessions", () => {
    const cp1 = makeCheckpoint({ sessionId: "s1" });
    initiateHandoff(cp1, "compaction", db, tmpDir);
    completeHandoff(db, selector(), "s1", "s2", tmpDir);

    const cp2 = makeCheckpoint({
      agentName: "builder-auth-r2",
      sessionId: "s2",
      currentBranch: "cnog/auth/builder-auth-r2",
    });
    initiateHandoff(cp2, "timeout", db, tmpDir);

    const handoffs = loadHandoffs(db, selector(), tmpDir);
    expect(handoffs).toHaveLength(2);
    expect(handoffs[0].toSessionId).toBe("s2");
    expect(handoffs[1].toSessionId).toBeNull();
  });
});
