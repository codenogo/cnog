import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MailClient } from "../src/mail.js";
import { Watchdog } from "../src/watchdog.js";
import { buildStatusSnapshot } from "../src/status.js";
import { buildDoctorChecks } from "../src/doctor.js";
import type { CnogConfig } from "../src/config.js";

let db: CnogDB;
let events: EventEmitter;
let mail: MailClient;
let tmpDir: string;
let config: CnogConfig;
let testRunId: string;

function createTestRun(db: CnogDB, feature: string = "test-feature"): string {
  const id = `run-sd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return id;
}

function createTestSession(db: CnogDB, runId: string, name: string, feature: string): string {
  const id = `sess-${name}`;
  db.sessions.create({
    id, name, logical_name: name, attempt: 1, runtime: "claude", capability: "builder",
    feature, task_id: null, worktree_path: null, branch: `cnog/${feature}/${name}`,
    tmux_session: `cnog-${name}`, pid: 123, state: "working", parent_agent: null, run_id: runId,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-status-doctor-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  mail = new MailClient(db);
  testRunId = createTestRun(db, "auth");
  config = {
    project: { name: "cnog", root: ".", canonicalBranch: "main" },
    agents: { runtime: "claude", maxConcurrent: 4, maxDepth: 2, staggerDelayMs: 2000, bootDelayMs: 2000 },
    orchestrator: { tickIntervalMs: 10_000, maxWip: 4 },
    watchdog: { staleThresholdMs: 60_000, zombieThresholdMs: 300_000 },
    verify: { commands: [] },
  };
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("status and doctor snapshots", () => {
  it("includes runtime, features, and health in the status snapshot", () => {
    const sessionId = createTestSession(db, testRunId, "builder-auth", "auth");
    db.db.prepare("UPDATE sessions SET started_at = ? WHERE name = ?").run("2026-03-26 12:00:00", "builder-auth");
    db.runs.update(testRunId, { status: "merge", profile: "feature-delivery" });
    db.sessions.create({
      id: "sess-eval-auth", name: "evaluator-auth", logical_name: "evaluator-auth", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: "auth", task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null, state: "completed",
      parent_agent: null, run_id: testRunId,
    });
    db.reviewScopes.create({
      id: "scope-auth-approved",
      run_id: testRunId,
      scope_status: "approved",
      scope_hash: "scope-auth",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: "APPROVE",
      evaluator_session: "sess-eval-auth",
    });
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: testRunId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => new Date("2026-03-26T12:02:00.000Z").getTime(),
      },
    );

    const snapshot = buildStatusSnapshot(db, config, watchdog);
    expect(snapshot.summary.configuredRuntime).toBe("claude");
    expect(snapshot.agents[0].runtime).toBe("claude");
    expect(snapshot.features[0]).toMatchObject({
      feature: "auth",
      phase: "merge",
      reviewVerdict: "APPROVE",
      profile: "feature-delivery",
    });
    expect(snapshot.health[0].decision.kind).toBe("stale");
  });

  it("shows the active review scope status instead of an older historical verdict", () => {
    db.runs.update(testRunId, { status: "evaluate" });
    db.sessions.create({
      id: "sess-eval-auth-old", name: "evaluator-auth-old", logical_name: "evaluator-auth-old",
      attempt: 1, runtime: "claude", capability: "evaluator", feature: "auth", task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null, state: "working",
      parent_agent: null, run_id: testRunId,
    });
    db.reviewScopes.create({
      id: "scope-auth-approved-old",
      run_id: testRunId,
      scope_status: "approved",
      scope_hash: "scope-auth-old",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: "APPROVE",
      evaluator_session: "sess-eval-auth-old",
    });
    db.reviewScopes.create({
      id: "scope-auth-pending-new",
      run_id: testRunId,
      scope_status: "pending",
      scope_hash: "scope-auth-new",
      merge_entries: JSON.stringify([]),
      branches: JSON.stringify([]),
      head_shas: JSON.stringify([]),
      contract_ids: JSON.stringify([]),
      contract_hashes: JSON.stringify([]),
      verify_commands: JSON.stringify([]),
      verdict: null,
      evaluator_session: null,
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => Date.now(),
      },
    );

    const snapshot = buildStatusSnapshot(db, config, watchdog);
    expect(snapshot.features[0]).toMatchObject({
      feature: "auth",
      phase: "evaluate",
      reviewVerdict: null,
    });
  });

  it("doctor flags runtime config and merge conflicts", () => {
    const sessionId = createTestSession(db, testRunId, "builder-auth-doc", "auth");
    db.merges.enqueue({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      agent_name: "builder-auth",
      run_id: testRunId,
      session_id: sessionId,
      task_id: null,
      head_sha: "abc123",
      files_modified: null,
    });
    const merge = db.merges.list()[0];
    db.merges.updateStatus(merge.id, "conflict");

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => Date.now(),
      },
    );

    const checks = buildDoctorChecks({
      projectRoot: tmpDir,
      initialized: true,
      config: { ...config, agents: { ...config.agents, runtime: "missing-runtime" } },
      db,
      watchdog,
    });

    expect(checks.find((check) => check.name === "configured runtime")?.ok).toBe(false);
    expect(checks.find((check) => check.name === "merge conflicts")?.ok).toBe(false);
  });
});
