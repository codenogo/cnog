/**
 * Schema consistency tests — verify SQL columns match TypeScript interfaces.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";

let db: CnogDB;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-schema-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function getColumns(tableName: string): string[] {
  const info = db.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return info.map((column) => column.name).sort();
}

describe("schema consistency", () => {
  it("sessions table has correct columns", () => {
    expect(getColumns("sessions")).toEqual([
      "attempt", "branch", "capability", "completed_at", "error", "feature", "id",
      "last_heartbeat", "logical_name", "name", "parent_agent", "pid", "run_id", "runtime",
      "started_at", "state", "task_id", "tmux_session", "worktree_path",
    ]);
  });

  it("messages table has correct columns", () => {
    expect(getColumns("messages")).toEqual([
      "body", "created_at", "from_agent", "id", "payload", "priority",
      "read", "run_id", "subject", "thread_id", "to_agent", "type",
    ]);
  });

  it("merge_queue table has correct columns", () => {
    expect(getColumns("merge_queue")).toEqual([
      "agent_name", "branch", "enqueued_at", "feature", "files_modified",
      "head_sha", "id", "merged_at", "resolved_tier", "run_id",
      "session_id", "status", "task_id",
    ]);
  });

  it("events table has correct columns", () => {
    expect(getColumns("events")).toEqual([
      "agent_name", "data", "event_type", "feature", "id", "level",
      "message", "source", "timestamp",
    ]);
  });

  it("issues table has correct columns", () => {
    expect(getColumns("issues")).toEqual([
      "assignee", "closed_at", "created_at", "description", "feature",
      "id", "issue_type", "metadata", "parent_id", "phase", "plan_number",
      "priority", "run_id", "status", "title", "updated_at",
    ]);
  });

  it("feature_phases table has correct columns", () => {
    expect(getColumns("feature_phases")).toEqual([
      "feature", "phase", "profile", "review_verdict", "updated_at",
    ]);
  });

  it("runs table has correct columns", () => {
    expect(getColumns("runs")).toEqual([
      "created_at", "feature", "id", "phase_reason", "plan_number", "profile", "review",
      "ship", "status", "tasks", "updated_at", "worktree_path",
    ]);
  });

  it("metrics table has correct columns", () => {
    expect(getColumns("metrics")).toEqual([
      "agent_name", "cost_usd", "feature", "id", "input_tokens",
      "output_tokens", "recorded_at", "run_id",
    ]);
  });

  it("artifacts table has correct columns", () => {
    expect(getColumns("artifacts")).toEqual([
      "created_at", "feature", "hash", "id", "issue_id", "path",
      "review_scope_id", "run_id", "session_id", "type",
    ]);
  });

  it("review_scopes table has correct columns", () => {
    expect(getColumns("review_scopes")).toEqual([
      "branches", "contract_hashes", "contract_ids", "created_at",
      "evaluated_at", "evaluator_session", "head_shas", "id",
      "merge_entries", "run_id", "scope_hash", "scope_status",
      "verdict", "verify_commands",
    ]);
  });

  it("review_attempts table has correct columns", () => {
    expect(getColumns("review_attempts")).toEqual([
      "completed_at", "created_at", "evaluator_session",
      "grading_artifact_id", "id", "report_artifact_id",
      "scope_id", "verdict",
    ]);
  });

  it("all expected indexes exist", () => {
    const indexes = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((entry) => entry.name).sort();

    expect(names).toContain("idx_sessions_state");
    expect(names).toContain("idx_sessions_logical_attempt");
    expect(names).toContain("idx_messages_to_read");
    expect(names).toContain("idx_merge_queue_status");
    expect(names).toContain("idx_events_agent_ts");
    expect(names).toContain("idx_issues_feature");
  });

  it("domain stores are accessible", () => {
    expect(db.sessions).toBeDefined();
    expect(db.messages).toBeDefined();
    expect(db.merges).toBeDefined();
    expect(db.runs).toBeDefined();
    expect(db.metrics).toBeDefined();
    expect(db.events).toBeDefined();
    expect(db.phases).toBeDefined();
    expect(db.issues).toBeDefined();
  });

  it("domain stores work directly", () => {
    db.runs.create({
      id: "run-test-1", feature: "test", plan_number: null, status: "plan",
      phase_reason: null, profile: null, tasks: null, review: null, ship: null,
      worktree_path: null,
    });
    db.sessions.create({
      id: "s1",
      name: "test-agent",
      logical_name: "test-agent",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: null,
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: null,
      pid: null,
      state: "booting",
      parent_agent: null,
      run_id: "run-test-1",
    });
    expect(db.sessions.get("test-agent")?.state).toBe("booting");
  });

  it("fails fast on an incompatible pre-cut schema", () => {
    db.close();

    const legacyPath = join(tmpDir, "legacy.db");
    const legacyDb = new Database(legacyPath);
    legacyDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        capability TEXT NOT NULL,
        feature TEXT,
        task_id TEXT,
        worktree_path TEXT,
        branch TEXT,
        tmux_session TEXT,
        pid INTEGER,
        state TEXT NOT NULL,
        parent_agent TEXT,
        run_id TEXT,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT,
        completed_at TEXT,
        error TEXT
      );
      CREATE TABLE feature_phases (
        feature TEXT PRIMARY KEY,
        phase TEXT NOT NULL DEFAULT 'discuss',
        review_verdict TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    expect(() => new CnogDB(legacyPath)).toThrow();

    db = new CnogDB(join(tmpDir, "test.db"));
  });
});
