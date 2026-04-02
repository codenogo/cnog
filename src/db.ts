/**
 * SQLite state plane — the persistent backbone of the orchestrator.
 *
 * Uses better-sqlite3 in WAL mode for concurrent reads from multiple agents.
 * Organized into domain stores for testability and clean boundaries.
 *
 * Foreign keys are enforced. run_id is required everywhere — no defaults.
 */

import Database from "better-sqlite3";
import type {
  ExecutionTaskControlState,
  SessionRow,
  SessionProgressRow,
  MessageRow,
  MergeQueueRow,
  RunRow,
  MetricRow,
  EventRow,
  FeaturePhaseRow,
  IssueRow,
  IssueDepRow,
  IssueEventRow,
  ArtifactRow,
  ReviewScopeRow,
  ReviewAttemptRow,
  ExecutionTaskRow,
} from "./types.js";
import {
  buildExecutionTaskProgressSnapshotFromSession,
  createExecutionTaskControlState,
  deriveExecutionTaskControlStateFromMutation,
  parseExecutionTaskControlState,
  serializeExecutionTaskControlState,
} from "./execution-task-state.js";
import { ExecutionTaskControlStateSchema } from "./types.js";

const SCHEMA = `
-- Delivery runs (must be created before sessions/issues/merge entries)
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  feature TEXT NOT NULL,
  plan_number TEXT,
  status TEXT NOT NULL DEFAULT 'plan' CHECK(status IN ('plan','contract','build','evaluate','merge','ship','done','failed')),
  phase_reason TEXT,
  profile TEXT,
  tasks TEXT,
  review TEXT,
  ship TEXT,
  worktree_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Agent lifecycle
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  logical_name TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
  runtime TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability IN ('planner','builder','evaluator')),
  feature TEXT,
  task_id TEXT,
  execution_task_id TEXT REFERENCES execution_tasks(id),
  worktree_path TEXT,
  transcript_path TEXT,
  branch TEXT,
  tmux_session TEXT,
  pid INTEGER,
  state TEXT NOT NULL CHECK(state IN ('booting','working','completed','stalled','failed')),
  parent_agent TEXT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat TEXT,
  completed_at TEXT,
  error TEXT
);

-- Inter-agent mail
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT,
  type TEXT NOT NULL CHECK(type IN ('status','worker_notification')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  thread_id TEXT,
  payload TEXT,
  run_id TEXT REFERENCES runs(id),
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FIFO merge queue
CREATE TABLE IF NOT EXISTS merge_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature TEXT NOT NULL,
  branch TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  task_id TEXT,
  head_sha TEXT NOT NULL,
  files_modified TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','merging','merged','conflict','failed')),
  resolved_tier TEXT CHECK(resolved_tier IS NULL OR resolved_tier IN ('clean','auto','ai','reimagine')),
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  merged_at TEXT
);

-- Token / cost tracking
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_name TEXT NOT NULL,
  feature TEXT NOT NULL DEFAULT '',
  run_id TEXT REFERENCES runs(id),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mutable per-session observability snapshot (non-authoritative)
CREATE TABLE IF NOT EXISTS session_progress (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id),
  execution_task_id TEXT REFERENCES execution_tasks(id),
  transcript_path TEXT,
  transcript_size INTEGER NOT NULL DEFAULT 0,
  last_output_at TEXT,
  last_activity_at TEXT,
  last_activity_kind TEXT CHECK(last_activity_kind IS NULL OR last_activity_kind IN ('read','write','search','bash','workflow','other')),
  last_activity_summary TEXT,
  last_tool_name TEXT,
  tool_use_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  recent_activities_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Structured event log
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug','info','warn','error')),
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  agent_name TEXT,
  feature TEXT,
  message TEXT NOT NULL,
  data TEXT
);

-- Feature lifecycle phases (derived projection only — not authority)
CREATE TABLE IF NOT EXISTS feature_phases (
  feature TEXT PRIMARY KEY,
  phase TEXT NOT NULL DEFAULT 'plan',
  review_verdict TEXT,
  profile TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Work-breakdown issues
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  issue_type TEXT NOT NULL DEFAULT 'task' CHECK(issue_type IN ('epic','task','subtask','bug')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done','closed')),
  priority INTEGER NOT NULL DEFAULT 1,
  assignee TEXT,
  feature TEXT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  plan_number TEXT,
  phase TEXT,
  parent_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

-- Issue dependencies
CREATE TABLE IF NOT EXISTS issue_deps (
  issue_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on)
);

-- Issue audit trail
CREATE TABLE IF NOT EXISTS issue_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT,
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Artifact registry (immutable — new version = new row)
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  feature TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('plan','prompt-contract','contract','checkpoint','review-scope','review-report','grading-report','verify-report','merge-record','ship-report')),
  path TEXT NOT NULL,
  hash TEXT NOT NULL,
  issue_id TEXT REFERENCES issues(id),
  session_id TEXT REFERENCES sessions(id),
  review_scope_id TEXT REFERENCES review_scopes(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Review scopes (exact candidate scope for evaluation)
CREATE TABLE IF NOT EXISTS review_scopes (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  scope_status TEXT NOT NULL DEFAULT 'pending' CHECK(scope_status IN ('pending','evaluating','approved','rejected','stale')),
  scope_hash TEXT NOT NULL,
  merge_entries TEXT NOT NULL DEFAULT '[]',
  branches TEXT NOT NULL DEFAULT '[]',
  head_shas TEXT NOT NULL DEFAULT '[]',
  contract_ids TEXT NOT NULL DEFAULT '[]',
  contract_hashes TEXT NOT NULL DEFAULT '[]',
  verify_commands TEXT NOT NULL DEFAULT '[]',
  verdict TEXT CHECK(verdict IS NULL OR verdict IN ('APPROVE','REQUEST_CHANGES','BLOCK')),
  evaluator_session TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  evaluated_at TEXT
);

-- Review attempts (each evaluator pass on a scope)
CREATE TABLE IF NOT EXISTS review_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id TEXT NOT NULL REFERENCES review_scopes(id),
  evaluator_session TEXT NOT NULL REFERENCES sessions(id),
  verdict TEXT NOT NULL CHECK(verdict IN ('APPROVE','REQUEST_CHANGES','BLOCK')),
  report_artifact_id TEXT REFERENCES artifacts(id),
  grading_artifact_id TEXT REFERENCES artifacts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Runtime execution tasks (stable work units; sessions are attempts)
CREATE TABLE IF NOT EXISTS execution_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  issue_id TEXT REFERENCES issues(id),
  review_scope_id TEXT REFERENCES review_scopes(id),
  parent_task_id TEXT REFERENCES execution_tasks(id),
  logical_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('build','contract_review','implementation_review','merge','verify')),
  capability TEXT NOT NULL CHECK(capability IN ('builder','evaluator','system','shell')),
  executor TEXT NOT NULL CHECK(executor IN ('agent','shell','system')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','blocked','completed','failed','superseded')),
  active_session_id TEXT REFERENCES sessions(id),
  summary TEXT,
  output_path TEXT,
  result_path TEXT,
  head_sha TEXT,
  files_modified TEXT,
  command TEXT,
  cwd TEXT,
  process_id INTEGER,
  exit_code INTEGER,
  output_size INTEGER NOT NULL DEFAULT 0,
  last_output_at TEXT,
  output_offset INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1)),
  notified_at TEXT,
  last_error TEXT,
  control_state_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Indexes for query performance
CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_feature ON sessions(feature);
CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);
CREATE INDEX IF NOT EXISTS idx_sessions_execution_task ON sessions(execution_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_logical_attempt ON sessions(logical_name, attempt);
CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_agent, read);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
CREATE INDEX IF NOT EXISTS idx_metrics_run ON metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_session_progress_run ON session_progress(run_id);
CREATE INDEX IF NOT EXISTS idx_merge_queue_status ON merge_queue(status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_merge_queue_run ON merge_queue(run_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent_name, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, timestamp);
CREATE INDEX IF NOT EXISTS idx_events_level ON events(level);
CREATE INDEX IF NOT EXISTS idx_issues_feature ON issues(feature, status);
CREATE INDEX IF NOT EXISTS idx_issues_run ON issues(run_id);
CREATE INDEX IF NOT EXISTS idx_issue_deps_issue ON issue_deps(issue_id);
CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(run_id, type);
CREATE INDEX IF NOT EXISTS idx_artifacts_feature ON artifacts(feature);
CREATE INDEX IF NOT EXISTS idx_review_scopes_run ON review_scopes(run_id);
CREATE INDEX IF NOT EXISTS idx_review_scopes_hash ON review_scopes(run_id, scope_hash);
CREATE INDEX IF NOT EXISTS idx_review_attempts_scope ON review_attempts(scope_id);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_run_status ON execution_tasks(run_id, status);
CREATE INDEX IF NOT EXISTS idx_execution_tasks_issue ON execution_tasks(issue_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_tasks_run_logical ON execution_tasks(run_id, logical_name);

-- Partial unique: one active (non-terminal) run per feature
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_active_feature
  ON runs(feature) WHERE status NOT IN ('done','failed');

-- Partial unique: one active (non-terminal) scope per run
CREATE UNIQUE INDEX IF NOT EXISTS idx_scopes_active_run
  ON review_scopes(run_id) WHERE scope_status IN ('pending','evaluating');
`;

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableSql(db: Database.Database, table: string): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string | null } | undefined;
  return row?.sql ?? "";
}

function messageIndexSql(): string {
  return `
    CREATE INDEX IF NOT EXISTS idx_messages_to_read ON messages(to_agent, read);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
    CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
  `;
}

function artifactIndexSql(): string {
  return `
    CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(run_id, type);
    CREATE INDEX IF NOT EXISTS idx_artifacts_feature ON artifacts(feature);
  `;
}

// ---------------------------------------------------------------------------
// Domain Store: Sessions
// ---------------------------------------------------------------------------

export class SessionStore {
  constructor(private readonly raw: Database.Database) {}

  create(
    row: Omit<SessionRow, "started_at" | "last_heartbeat" | "completed_at" | "error" | "execution_task_id">
      & { execution_task_id?: string | null },
  ): void {
    this.raw
      .prepare(
        `INSERT INTO sessions (id, name, logical_name, attempt, runtime, capability, feature, task_id, execution_task_id, worktree_path, transcript_path, branch, tmux_session, pid, state, parent_agent, run_id, started_at)
         VALUES (@id, @name, @logical_name, @attempt, @runtime, @capability, @feature, @task_id, @execution_task_id, @worktree_path, @transcript_path, @branch, @tmux_session, @pid, @state, @parent_agent, @run_id, @started_at)`,
      )
      .run({
        ...row,
        execution_task_id: row.execution_task_id ?? null,
        started_at: now(),
      });
  }

  get(name: string): SessionRow | undefined {
    return this.raw.prepare("SELECT * FROM sessions WHERE name = ?").get(name) as SessionRow | undefined;
  }

  getById(id: string): SessionRow | undefined {
    return this.raw.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  getLatestByLogicalName(logicalName: string): SessionRow | undefined {
    return this.raw
      .prepare("SELECT * FROM sessions WHERE logical_name = ? ORDER BY attempt DESC, started_at DESC LIMIT 1")
      .get(logicalName) as SessionRow | undefined;
  }

  updateState(name: string, state: string, error?: string): void {
    const completedAt = state === "completed" || state === "failed" ? now() : null;
    this.raw
      .prepare(`UPDATE sessions SET state = ?, error = ?, completed_at = COALESCE(?, completed_at) WHERE name = ?`)
      .run(state, error ?? null, completedAt, name);
  }

  heartbeat(name: string): void {
    this.raw.prepare("UPDATE sessions SET last_heartbeat = ? WHERE name = ?").run(now(), name);
  }

  list(opts?: { state?: string; feature?: string; run_id?: string }): SessionRow[] {
    let sql = "SELECT * FROM sessions WHERE 1=1";
    const params: Record<string, string> = {};
    if (opts?.state) { sql += " AND state = @state"; params.state = opts.state; }
    if (opts?.feature) { sql += " AND feature = @feature"; params.feature = opts.feature; }
    if (opts?.run_id) { sql += " AND run_id = @run_id"; params.run_id = opts.run_id; }
    sql += " ORDER BY started_at DESC";
    return this.raw.prepare(sql).all(params) as SessionRow[];
  }

  active(): SessionRow[] {
    return this.raw
      .prepare("SELECT * FROM sessions WHERE state NOT IN ('completed', 'failed') ORDER BY started_at DESC")
      .all() as SessionRow[];
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Messages
// ---------------------------------------------------------------------------

export class MessageStore {
  constructor(private readonly raw: Database.Database) {}

  send(msg: Omit<MessageRow, "id" | "read" | "created_at">): number {
    const result = this.raw
      .prepare(
        `INSERT INTO messages (from_agent, to_agent, subject, body, type, priority, thread_id, payload, run_id)
         VALUES (@from_agent, @to_agent, @subject, @body, @type, @priority, @thread_id, @payload, @run_id)`,
      )
      .run(msg);
    return Number(result.lastInsertRowid);
  }

  checkMail(agent: string): MessageRow[] {
    return this.raw
      .prepare("SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY created_at ASC")
      .all(agent) as MessageRow[];
  }

  list(agent: string, limit: number = 50): MessageRow[] {
    return this.raw
      .prepare("SELECT * FROM messages WHERE to_agent = ? OR from_agent = ? ORDER BY created_at DESC LIMIT ?")
      .all(agent, agent, limit) as MessageRow[];
  }

  markRead(id: number): void {
    this.raw.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id);
  }

  markAllRead(agent: string): void {
    this.raw.prepare("UPDATE messages SET read = 1 WHERE to_agent = ? AND read = 0").run(agent);
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Merge Queue
// ---------------------------------------------------------------------------

export class MergeStore {
  constructor(private readonly raw: Database.Database) {}

  enqueue(entry: Omit<MergeQueueRow, "id" | "status" | "resolved_tier" | "enqueued_at" | "merged_at">): number {
    const result = this.raw
      .prepare(
        `INSERT INTO merge_queue (feature, branch, agent_name, run_id, session_id, task_id, head_sha, files_modified)
         VALUES (@feature, @branch, @agent_name, @run_id, @session_id, @task_id, @head_sha, @files_modified)`,
      )
      .run(entry);
    return Number(result.lastInsertRowid);
  }

  pending(feature?: string): MergeQueueRow[] {
    if (feature) {
      return this.raw
        .prepare("SELECT * FROM merge_queue WHERE status = 'pending' AND feature = ? ORDER BY enqueued_at ASC")
        .all(feature) as MergeQueueRow[];
    }
    return this.raw
      .prepare("SELECT * FROM merge_queue WHERE status = 'pending' ORDER BY enqueued_at ASC")
      .all() as MergeQueueRow[];
  }

  pendingForRun(runId: string): MergeQueueRow[] {
    return this.raw
      .prepare("SELECT * FROM merge_queue WHERE status = 'pending' AND run_id = ? ORDER BY enqueued_at ASC")
      .all(runId) as MergeQueueRow[];
  }

  list(feature?: string): MergeQueueRow[] {
    if (feature) {
      return this.raw
        .prepare("SELECT * FROM merge_queue WHERE feature = ? ORDER BY enqueued_at ASC")
        .all(feature) as MergeQueueRow[];
    }
    return this.raw
      .prepare("SELECT * FROM merge_queue ORDER BY enqueued_at ASC")
      .all() as MergeQueueRow[];
  }

  listForRun(runId: string): MergeQueueRow[] {
    return this.raw
      .prepare("SELECT * FROM merge_queue WHERE run_id = ? ORDER BY enqueued_at ASC")
      .all(runId) as MergeQueueRow[];
  }

  updateStatus(id: number, status: string, resolvedTier?: string): void {
    const mergedAt = status === "merged" ? now() : null;
    this.raw
      .prepare("UPDATE merge_queue SET status = ?, resolved_tier = ?, merged_at = COALESCE(?, merged_at) WHERE id = ?")
      .run(status, resolvedTier ?? null, mergedAt, id);
  }

  failNonMergedForRun(runId: string): void {
    this.raw
      .prepare(
        "UPDATE merge_queue SET status = 'failed', resolved_tier = COALESCE(resolved_tier, 'reimagine') WHERE run_id = ? AND status != 'merged'",
      )
      .run(runId);
  }

  failPendingForIssue(runId: string, issueId: string): void {
    this.raw
      .prepare(
        "UPDATE merge_queue SET status = 'failed', resolved_tier = COALESCE(resolved_tier, 'reimagine') WHERE run_id = ? AND task_id = ? AND status = 'pending'",
      )
      .run(runId, issueId);
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Runs
// ---------------------------------------------------------------------------

export class RunStore {
  constructor(private readonly raw: Database.Database) {}

  create(run: Omit<RunRow, "created_at" | "updated_at">): void {
    this.raw
      .prepare(
        `INSERT INTO runs (id, feature, plan_number, status, phase_reason, profile, tasks, review, ship, worktree_path, created_at, updated_at)
         VALUES (@id, @feature, @plan_number, @status, @phase_reason, @profile, @tasks, @review, @ship, @worktree_path, @created_at, @updated_at)`,
      )
      .run({ ...run, created_at: now(), updated_at: now() });
  }

  get(id: string): RunRow | undefined {
    return this.raw.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
  }

  listByFeature(feature: string): RunRow[] {
    return this.raw
      .prepare("SELECT * FROM runs WHERE feature = ? ORDER BY created_at DESC, rowid DESC")
      .all(feature) as RunRow[];
  }

  latestForFeature(feature: string): RunRow | undefined {
    return this.raw
      .prepare("SELECT * FROM runs WHERE feature = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(feature) as RunRow | undefined;
  }

  activeForFeature(feature: string): RunRow | undefined {
    return this.raw
      .prepare("SELECT * FROM runs WHERE feature = ? AND status NOT IN ('done','failed') LIMIT 1")
      .get(feature) as RunRow | undefined;
  }

  update(id: string, fields: Partial<Pick<RunRow, "status" | "phase_reason" | "profile" | "review" | "ship" | "tasks">>): void {
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, string | null> = { id, updated_at: now() };
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = @${key}`);
      params[key] = value ?? null;
    }
    this.raw.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Metrics
// ---------------------------------------------------------------------------

export class MetricStore {
  constructor(private readonly raw: Database.Database) {}

  record(entry: Omit<MetricRow, "id" | "recorded_at">): void {
    this.raw
      .prepare(`INSERT INTO metrics (agent_name, feature, run_id, input_tokens, output_tokens, cost_usd) VALUES (@agent_name, @feature, @run_id, @input_tokens, @output_tokens, @cost_usd)`)
      .run(entry);
  }

  summary(): { total_cost: number; total_input: number; total_output: number } {
    return this.raw
      .prepare("SELECT COALESCE(SUM(cost_usd),0) as total_cost, COALESCE(SUM(input_tokens),0) as total_input, COALESCE(SUM(output_tokens),0) as total_output FROM metrics")
      .get() as { total_cost: number; total_input: number; total_output: number };
  }

  summaryForAgent(agentName: string, runId?: string | null): { total_cost: number; total_input: number; total_output: number; samples: number } {
    if (runId) {
      return this.raw
        .prepare(
          `SELECT
             COALESCE(SUM(cost_usd),0) as total_cost,
             COALESCE(SUM(input_tokens),0) as total_input,
             COALESCE(SUM(output_tokens),0) as total_output,
             COUNT(*) as samples
           FROM metrics
           WHERE agent_name = ? AND run_id = ?`,
        )
        .get(agentName, runId) as { total_cost: number; total_input: number; total_output: number; samples: number };
    }

    return this.raw
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd),0) as total_cost,
           COALESCE(SUM(input_tokens),0) as total_input,
           COALESCE(SUM(output_tokens),0) as total_output,
           COUNT(*) as samples
         FROM metrics
         WHERE agent_name = ?`,
      )
      .get(agentName) as { total_cost: number; total_input: number; total_output: number; samples: number };
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Session Progress (non-authoritative observability)
// ---------------------------------------------------------------------------

export class SessionProgressStore {
  constructor(private readonly raw: Database.Database) {}

  private syncExecutionTaskProgress(sessionId: string): void {
    const progress = this.get(sessionId);
    const executionTaskId = progress?.execution_task_id;
    if (!progress || !executionTaskId) {
      return;
    }

    const taskRow = this.raw
      .prepare("SELECT * FROM execution_tasks WHERE id = ?")
      .get(executionTaskId) as ExecutionTaskRow | undefined;
    if (!taskRow) {
      return;
    }

    const currentState = parseExecutionTaskControlState(
      taskRow.control_state_json,
      taskRow.status,
    );
    const nextState = {
      ...currentState,
      progress: buildExecutionTaskProgressSnapshotFromSession(progress),
    };

    this.raw
      .prepare("UPDATE execution_tasks SET control_state_json = ? WHERE id = ?")
      .run(serializeExecutionTaskControlState(nextState), executionTaskId);
  }

  get(sessionId: string): SessionProgressRow | undefined {
    return this.raw
      .prepare("SELECT * FROM session_progress WHERE session_id = ?")
      .get(sessionId) as SessionProgressRow | undefined;
  }

  getByAgent(agentName: string): SessionProgressRow | undefined {
    return this.raw
      .prepare(
        `SELECT sp.*
         FROM session_progress sp
         JOIN sessions s ON s.id = sp.session_id
         WHERE s.name = ?`,
      )
      .get(agentName) as SessionProgressRow | undefined;
  }

  listByRun(runId: string): SessionProgressRow[] {
    return this.raw
      .prepare("SELECT * FROM session_progress WHERE run_id = ? ORDER BY updated_at DESC")
      .all(runId) as SessionProgressRow[];
  }

  ensureFromSession(sessionId: string): void {
    this.raw
      .prepare(
        `INSERT INTO session_progress (
           session_id, run_id, execution_task_id, transcript_path, updated_at
         )
         SELECT id, run_id, execution_task_id, transcript_path, @updated_at
         FROM sessions
         WHERE id = @session_id
         ON CONFLICT(session_id) DO UPDATE SET
           run_id = excluded.run_id,
           execution_task_id = excluded.execution_task_id,
           transcript_path = excluded.transcript_path,
           updated_at = excluded.updated_at`,
      )
      .run({ session_id: sessionId, updated_at: now() });
  }

  update(
    sessionId: string,
    fields: Partial<Pick<
      SessionProgressRow,
      | "run_id"
      | "execution_task_id"
      | "transcript_path"
      | "transcript_size"
      | "last_output_at"
      | "last_activity_at"
      | "last_activity_kind"
      | "last_activity_summary"
      | "last_tool_name"
      | "tool_use_count"
      | "input_tokens"
      | "output_tokens"
      | "cost_usd"
      | "recent_activities_json"
    >>,
  ): void {
    this.ensureFromSession(sessionId);
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, string | number | null> = {
      session_id: sessionId,
      updated_at: now(),
    };
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = @${key}`);
      params[key] = value ?? null;
    }
    this.raw
      .prepare(`UPDATE session_progress SET ${sets.join(", ")} WHERE session_id = @session_id`)
      .run(params);
    this.syncExecutionTaskProgress(sessionId);
  }

  recordActivity(opts: {
    sessionId: string;
    runId: string;
    executionTaskId?: string | null;
    transcriptPath?: string | null;
    transcriptSize?: number;
    toolName?: string | null;
    activityKind: SessionProgressRow["last_activity_kind"];
    summary: string;
    target?: string | null;
    at?: string;
  }): void {
    const existing = this.get(opts.sessionId);
    const at = opts.at ?? now();
    const recent = existing
      ? JSON.parse(existing.recent_activities_json) as Array<{ at: string; kind: string | null; tool: string | null; target: string | null; summary: string }>
      : [];
    recent.push({
      at,
      kind: opts.activityKind,
      tool: opts.toolName ?? null,
      target: opts.target ?? null,
      summary: opts.summary,
    });
    const recentTrimmed = recent.slice(-8);

    const nextToolCount = (existing?.tool_use_count ?? 0) + 1;
    this.ensureFromSession(opts.sessionId);
    this.update(opts.sessionId, {
      run_id: opts.runId,
      execution_task_id: opts.executionTaskId ?? existing?.execution_task_id ?? null,
      transcript_path: opts.transcriptPath ?? existing?.transcript_path ?? null,
      transcript_size: opts.transcriptSize ?? existing?.transcript_size ?? 0,
      last_output_at: opts.transcriptSize !== undefined ? at : (existing?.last_output_at ?? null),
      last_activity_at: at,
      last_activity_kind: opts.activityKind ?? null,
      last_activity_summary: opts.summary,
      last_tool_name: opts.toolName ?? null,
      tool_use_count: nextToolCount,
      recent_activities_json: JSON.stringify(recentTrimmed),
    });
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Events
// ---------------------------------------------------------------------------

export class EventStore {
  constructor(private readonly raw: Database.Database) {}

  log(entry: Omit<EventRow, "id" | "timestamp">): void {
    this.raw
      .prepare(`INSERT INTO events (timestamp, level, source, event_type, agent_name, feature, message, data) VALUES (@timestamp, @level, @source, @event_type, @agent_name, @feature, @message, @data)`)
      .run({ ...entry, timestamp: now() });
  }

  query(opts?: { agent?: string; source?: string; level?: string; since?: string; limit?: number }): EventRow[] {
    let sql = "SELECT * FROM events WHERE 1=1";
    const params: Record<string, string | number> = {};
    if (opts?.agent) { sql += " AND agent_name = @agent"; params.agent = opts.agent; }
    if (opts?.source) { sql += " AND source = @source"; params.source = opts.source; }
    if (opts?.level) { sql += " AND level = @level"; params.level = opts.level; }
    if (opts?.since) { sql += " AND timestamp >= @since"; params.since = opts.since; }
    sql += " ORDER BY timestamp DESC LIMIT @limit";
    params.limit = opts?.limit ?? 100;
    return this.raw.prepare(sql).all(params) as EventRow[];
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Feature Phases (derived projection — not authority)
// ---------------------------------------------------------------------------

export class PhaseStore {
  constructor(private readonly raw: Database.Database) {}

  get(feature: string): FeaturePhaseRow | undefined {
    return this.raw.prepare("SELECT * FROM feature_phases WHERE feature = ?").get(feature) as FeaturePhaseRow | undefined;
  }

  set(feature: string, phase: string, reviewVerdict?: string, profile?: string): void {
    this.raw
      .prepare(
        `INSERT INTO feature_phases (feature, phase, review_verdict, profile, updated_at)
         VALUES (@feature, @phase, @review_verdict, @profile, @updated_at)
         ON CONFLICT(feature) DO UPDATE SET
           phase = @phase,
           review_verdict = CASE
             WHEN @review_verdict IS NOT NULL THEN @review_verdict
             WHEN @phase IN ('plan', 'contract', 'build') THEN NULL
             ELSE review_verdict
           END,
           profile = COALESCE(@profile, profile),
           updated_at = @updated_at`,
      )
      .run({ feature, phase, review_verdict: reviewVerdict ?? null, profile: profile ?? null, updated_at: now() });
  }

  setVerdict(feature: string, verdict: string): void {
    this.raw
      .prepare("UPDATE feature_phases SET review_verdict = ?, updated_at = ? WHERE feature = ?")
      .run(verdict, now(), feature);
  }

  setProfile(feature: string, profile: string): void {
    this.raw
      .prepare("UPDATE feature_phases SET profile = ?, updated_at = ? WHERE feature = ?")
      .run(profile, now(), feature);
  }

  list(): FeaturePhaseRow[] {
    return this.raw.prepare("SELECT * FROM feature_phases ORDER BY feature").all() as FeaturePhaseRow[];
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Issues
// ---------------------------------------------------------------------------

export class IssueStore {
  constructor(private readonly raw: Database.Database) {}

  create(issue: Omit<IssueRow, "created_at" | "updated_at" | "closed_at">): void {
    this.raw
      .prepare(
        `INSERT INTO issues (id, title, description, issue_type, status, priority, assignee, feature, run_id, plan_number, phase, parent_id, metadata, created_at, updated_at)
         VALUES (@id, @title, @description, @issue_type, @status, @priority, @assignee, @feature, @run_id, @plan_number, @phase, @parent_id, @metadata, @created_at, @updated_at)`,
      )
      .run({ ...issue, created_at: now(), updated_at: now() });
  }

  get(id: string): IssueRow | undefined {
    return this.raw.prepare("SELECT * FROM issues WHERE id = ?").get(id) as IssueRow | undefined;
  }

  update(id: string, fields: Partial<Pick<IssueRow, "status" | "assignee" | "priority" | "description" | "metadata">>): void {
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, string | number | null> = { id, updated_at: now() };
    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = @${key}`);
      params[key] = value ?? null;
    }
    this.raw.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  close(id: string): void {
    this.raw.prepare("UPDATE issues SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), id);
  }

  list(opts?: { feature?: string; status?: string; assignee?: string; issue_type?: string; run_id?: string }): IssueRow[] {
    let sql = "SELECT * FROM issues WHERE 1=1";
    const params: Record<string, string> = {};
    if (opts?.feature) { sql += " AND feature = @feature"; params.feature = opts.feature; }
    if (opts?.status) { sql += " AND status = @status"; params.status = opts.status; }
    if (opts?.assignee) { sql += " AND assignee = @assignee"; params.assignee = opts.assignee; }
    if (opts?.issue_type) { sql += " AND issue_type = @issue_type"; params.issue_type = opts.issue_type; }
    if (opts?.run_id) { sql += " AND run_id = @run_id"; params.run_id = opts.run_id; }
    sql += " ORDER BY priority ASC, created_at ASC";
    return this.raw.prepare(sql).all(params) as IssueRow[];
  }

  addDep(issueId: string, dependsOn: string): void {
    this.raw.prepare("INSERT OR IGNORE INTO issue_deps (issue_id, depends_on) VALUES (?, ?)").run(issueId, dependsOn);
  }

  getDeps(issueId: string): IssueDepRow[] {
    return this.raw.prepare("SELECT * FROM issue_deps WHERE issue_id = ?").all(issueId) as IssueDepRow[];
  }

  logEvent(entry: Omit<IssueEventRow, "id" | "created_at">): void {
    this.raw
      .prepare(`INSERT INTO issue_events (issue_id, event_type, actor, data) VALUES (@issue_id, @event_type, @actor, @data)`)
      .run(entry);
  }

  getEvents(issueId: string): IssueEventRow[] {
    return this.raw.prepare("SELECT * FROM issue_events WHERE issue_id = ? ORDER BY created_at ASC").all(issueId) as IssueEventRow[];
  }

  resetRun(runId: string): void {
    this.raw
      .prepare(
        "UPDATE issues SET status = 'open', assignee = NULL, closed_at = NULL, updated_at = ? WHERE run_id = ?",
      )
      .run(now(), runId);
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Artifacts (immutable)
// ---------------------------------------------------------------------------

export class ArtifactStore {
  constructor(private readonly raw: Database.Database) {}

  create(row: Omit<ArtifactRow, "created_at">): void {
    this.raw
      .prepare(
        `INSERT INTO artifacts (id, run_id, feature, type, path, hash, issue_id, session_id, review_scope_id)
         VALUES (@id, @run_id, @feature, @type, @path, @hash, @issue_id, @session_id, @review_scope_id)`,
      )
      .run(row);
  }

  get(id: string): ArtifactRow | undefined {
    return this.raw.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
  }

  listByRun(runId: string, type?: string): ArtifactRow[] {
    if (type) {
      return this.raw
        .prepare("SELECT * FROM artifacts WHERE run_id = ? AND type = ? ORDER BY created_at ASC, rowid ASC")
        .all(runId, type) as ArtifactRow[];
    }
    return this.raw
      .prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(runId) as ArtifactRow[];
  }

  listByIssue(issueId: string): ArtifactRow[] {
    return this.raw
      .prepare("SELECT * FROM artifacts WHERE issue_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(issueId) as ArtifactRow[];
  }

  listByFeature(feature: string): ArtifactRow[] {
    return this.raw
      .prepare("SELECT * FROM artifacts WHERE feature = ? ORDER BY created_at ASC, rowid ASC")
      .all(feature) as ArtifactRow[];
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Review Scopes
// ---------------------------------------------------------------------------

export class ReviewScopeStore {
  constructor(private readonly raw: Database.Database) {}

  create(row: Omit<ReviewScopeRow, "created_at" | "evaluated_at">): void {
    this.raw
      .prepare(
        `INSERT INTO review_scopes (id, run_id, scope_status, scope_hash, merge_entries, branches, head_shas, contract_ids, contract_hashes, verify_commands, verdict, evaluator_session)
         VALUES (@id, @run_id, @scope_status, @scope_hash, @merge_entries, @branches, @head_shas, @contract_ids, @contract_hashes, @verify_commands, @verdict, @evaluator_session)`,
      )
      .run(row);
  }

  get(id: string): ReviewScopeRow | undefined {
    return this.raw.prepare("SELECT * FROM review_scopes WHERE id = ?").get(id) as ReviewScopeRow | undefined;
  }

  getByHash(runId: string, hash: string): ReviewScopeRow | undefined {
    return this.raw
      .prepare("SELECT * FROM review_scopes WHERE run_id = ? AND scope_hash = ? ORDER BY created_at DESC LIMIT 1")
      .get(runId, hash) as ReviewScopeRow | undefined;
  }

  setVerdict(id: string, verdict: string, evaluatorSession: string): void {
    const scopeStatus = verdict === "APPROVE" ? "approved" : "rejected";
    this.raw
      .prepare("UPDATE review_scopes SET verdict = ?, scope_status = ?, evaluator_session = ?, evaluated_at = ? WHERE id = ?")
      .run(verdict, scopeStatus, evaluatorSession, now(), id);
  }

  updateStatus(id: string, status: string): void {
    this.raw
      .prepare("UPDATE review_scopes SET scope_status = ? WHERE id = ?")
      .run(status, id);
  }

  staleForRun(runId: string): void {
    this.raw
      .prepare(
        "UPDATE review_scopes SET scope_status = 'stale' WHERE run_id = ? AND scope_status != 'stale'",
      )
      .run(runId);
  }

  listByRun(runId: string): ReviewScopeRow[] {
    return this.raw
      .prepare("SELECT * FROM review_scopes WHERE run_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(runId) as ReviewScopeRow[];
  }

  latestApproved(runId: string): ReviewScopeRow | undefined {
    return this.raw
      .prepare("SELECT * FROM review_scopes WHERE run_id = ? AND scope_status = 'approved' ORDER BY evaluated_at DESC LIMIT 1")
      .get(runId) as ReviewScopeRow | undefined;
  }

  activeForRun(runId: string): ReviewScopeRow | undefined {
    return this.raw
      .prepare(
        "SELECT * FROM review_scopes WHERE run_id = ? AND scope_status IN ('pending','evaluating') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(runId) as ReviewScopeRow | undefined;
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Review Attempts
// ---------------------------------------------------------------------------

export class ReviewAttemptStore {
  constructor(private readonly raw: Database.Database) {}

  create(row: Omit<ReviewAttemptRow, "id" | "created_at">): void {
    this.raw
      .prepare(
        `INSERT INTO review_attempts (scope_id, evaluator_session, verdict, report_artifact_id, grading_artifact_id, completed_at)
         VALUES (@scope_id, @evaluator_session, @verdict, @report_artifact_id, @grading_artifact_id, @completed_at)`,
      )
      .run(row);
  }

  listByScope(scopeId: string): ReviewAttemptRow[] {
    return this.raw
      .prepare("SELECT * FROM review_attempts WHERE scope_id = ? ORDER BY created_at ASC")
      .all(scopeId) as ReviewAttemptRow[];
  }
}

// ---------------------------------------------------------------------------
// Domain Store: Execution Tasks
// ---------------------------------------------------------------------------

export class ExecutionTaskStore {
  constructor(private readonly raw: Database.Database) {}

  create(
    row: Omit<ExecutionTaskRow, "created_at" | "updated_at" | "completed_at" | "command" | "cwd" | "process_id" | "exit_code" | "output_size" | "last_output_at" | "head_sha" | "files_modified" | "control_state_json"> & Partial<Pick<ExecutionTaskRow, "command" | "cwd" | "process_id" | "exit_code" | "output_size" | "last_output_at" | "head_sha" | "files_modified" | "control_state_json">>,
  ): void {
    const taskStatus = row.status ?? "pending";
    const controlStateJson = row.control_state_json
      ?? serializeExecutionTaskControlState(createExecutionTaskControlState(taskStatus));
    this.raw
      .prepare(
        `INSERT INTO execution_tasks (id, run_id, issue_id, review_scope_id, parent_task_id, logical_name, kind, capability, executor, status, active_session_id, summary, output_path, result_path, head_sha, files_modified, command, cwd, process_id, exit_code, output_size, last_output_at, output_offset, notified, notified_at, last_error, control_state_json, created_at, updated_at)
         VALUES (@id, @run_id, @issue_id, @review_scope_id, @parent_task_id, @logical_name, @kind, @capability, @executor, @status, @active_session_id, @summary, @output_path, @result_path, @head_sha, @files_modified, @command, @cwd, @process_id, @exit_code, @output_size, @last_output_at, @output_offset, @notified, @notified_at, @last_error, @control_state_json, @created_at, @updated_at)`,
      )
      .run({
        ...row,
        head_sha: row.head_sha ?? null,
        files_modified: row.files_modified ?? null,
        command: row.command ?? null,
        cwd: row.cwd ?? null,
        process_id: row.process_id ?? null,
        exit_code: row.exit_code ?? null,
        output_size: row.output_size ?? 0,
        last_output_at: row.last_output_at ?? null,
        control_state_json: controlStateJson,
        created_at: now(),
        updated_at: now(),
      });
  }

  get(id: string): ExecutionTaskRow | undefined {
    return this.raw.prepare("SELECT * FROM execution_tasks WHERE id = ?").get(id) as ExecutionTaskRow | undefined;
  }

  getByLogicalName(runId: string, logicalName: string): ExecutionTaskRow | undefined {
    return this.raw
      .prepare(
        "SELECT * FROM execution_tasks WHERE run_id = ? AND logical_name = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(runId, logicalName) as ExecutionTaskRow | undefined;
  }

  list(opts?: {
    run_id?: string;
    issue_id?: string;
    review_scope_id?: string;
    parent_task_id?: string;
    status?: string;
    capability?: string;
    kind?: string;
  }): ExecutionTaskRow[] {
    let sql = "SELECT * FROM execution_tasks WHERE 1=1";
    const params: Record<string, string> = {};
    if (opts?.run_id) { sql += " AND run_id = @run_id"; params.run_id = opts.run_id; }
    if (opts?.issue_id) { sql += " AND issue_id = @issue_id"; params.issue_id = opts.issue_id; }
    if (opts?.review_scope_id) { sql += " AND review_scope_id = @review_scope_id"; params.review_scope_id = opts.review_scope_id; }
    if (opts?.parent_task_id) { sql += " AND parent_task_id = @parent_task_id"; params.parent_task_id = opts.parent_task_id; }
    if (opts?.status) { sql += " AND status = @status"; params.status = opts.status; }
    if (opts?.capability) { sql += " AND capability = @capability"; params.capability = opts.capability; }
    if (opts?.kind) { sql += " AND kind = @kind"; params.kind = opts.kind; }
    sql += " ORDER BY created_at ASC, rowid ASC";
    return this.raw.prepare(sql).all(params) as ExecutionTaskRow[];
  }

  active(runId?: string): ExecutionTaskRow[] {
    if (runId) {
      return this.raw
        .prepare("SELECT * FROM execution_tasks WHERE run_id = ? AND status NOT IN ('blocked','completed','failed','superseded') ORDER BY created_at ASC, rowid ASC")
        .all(runId) as ExecutionTaskRow[];
    }
    return this.raw
      .prepare("SELECT * FROM execution_tasks WHERE status NOT IN ('blocked','completed','failed','superseded') ORDER BY created_at ASC, rowid ASC")
      .all() as ExecutionTaskRow[];
  }

  childrenOf(parentTaskId: string): ExecutionTaskRow[] {
    return this.raw
      .prepare("SELECT * FROM execution_tasks WHERE parent_task_id = ? ORDER BY created_at ASC, rowid ASC")
      .all(parentTaskId) as ExecutionTaskRow[];
  }

  update(
    id: string,
    fields: Partial<Pick<ExecutionTaskRow, "status" | "active_session_id" | "summary" | "output_path" | "result_path" | "head_sha" | "files_modified" | "command" | "cwd" | "process_id" | "exit_code" | "output_size" | "last_output_at" | "output_offset" | "notified" | "notified_at" | "last_error" | "issue_id" | "review_scope_id" | "parent_task_id" | "control_state_json">>,
  ): void {
    const existing = this.get(id);
    if (!existing) {
      return;
    }

    const updatedAt = now();
    const sets: string[] = ["updated_at = @updated_at"];
    const params: Record<string, string | number | null> = { id, updated_at: updatedAt };
    const terminalStatus = fields.status === "completed" || fields.status === "failed" || fields.status === "superseded";
    if (terminalStatus) {
      sets.push("completed_at = @completed_at");
      params.completed_at = updatedAt;
    } else if (fields.status === "pending" || fields.status === "running" || fields.status === "blocked") {
      sets.push("completed_at = NULL");
    }

    const nextControlStateJson = fields.control_state_json
      ?? serializeExecutionTaskControlState(deriveExecutionTaskControlStateFromMutation(existing, fields, updatedAt));
    fields.control_state_json = nextControlStateJson;

    for (const [key, value] of Object.entries(fields)) {
      sets.push(`${key} = @${key}`);
      params[key] = value ?? null;
    }
    this.raw.prepare(`UPDATE execution_tasks SET ${sets.join(", ")} WHERE id = @id`).run(params);
  }

  markNotified(id: string): void {
    this.update(id, {
      notified: 1,
      notified_at: now(),
    });
  }

  pendingNotifications(runId?: string): ExecutionTaskRow[] {
    if (runId) {
      return this.raw
        .prepare(
          "SELECT * FROM execution_tasks WHERE run_id = ? AND status IN ('completed','failed','superseded') AND notified = 0 ORDER BY completed_at ASC, rowid ASC",
        )
        .all(runId) as ExecutionTaskRow[];
    }

    return this.raw
      .prepare(
        "SELECT * FROM execution_tasks WHERE status IN ('completed','failed','superseded') AND notified = 0 ORDER BY completed_at ASC, rowid ASC",
      )
      .all() as ExecutionTaskRow[];
  }

  controlState(taskOrId: ExecutionTaskRow | string): ExecutionTaskControlState {
    const task = typeof taskOrId === "string" ? this.get(taskOrId) : taskOrId;
    if (!task) {
      return createExecutionTaskControlState();
    }
    return parseExecutionTaskControlState(task.control_state_json, task.status);
  }

  updateControlState(
    id: string,
    recipe: (state: ExecutionTaskControlState, task: ExecutionTaskRow) => ExecutionTaskControlState,
  ): ExecutionTaskControlState | undefined {
    const task = this.get(id);
    if (!task) {
      return undefined;
    }
    const nextState = recipe(
      parseExecutionTaskControlState(task.control_state_json, task.status),
      task,
    );
    this.update(id, {
      control_state_json: serializeExecutionTaskControlState(nextState),
    });
    return nextState;
  }
}

// ---------------------------------------------------------------------------
// Main Database (facade with domain stores)
// ---------------------------------------------------------------------------

/**
 * The central database for all orchestrator state.
 *
 * Access domain stores via:
 *   db.sessions.create(), db.messages.send(), db.merges.enqueue(), etc.
 */
export class CnogDB {
  readonly db: Database.Database;

  // Domain stores
  readonly sessions: SessionStore;
  readonly messages: MessageStore;
  readonly merges: MergeStore;
  readonly runs: RunStore;
  readonly metrics: MetricStore;
  readonly sessionProgress: SessionProgressStore;
  readonly events: EventStore;
  readonly phases: PhaseStore;
  readonly issues: IssueStore;
  readonly artifacts: ArtifactStore;
  readonly reviewScopes: ReviewScopeStore;
  readonly reviewAttempts: ReviewAttemptStore;
  readonly executionTasks: ExecutionTaskStore;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.migrateSchema();

    this.sessions = new SessionStore(this.db);
    this.messages = new MessageStore(this.db);
    this.merges = new MergeStore(this.db);
    this.runs = new RunStore(this.db);
    this.metrics = new MetricStore(this.db);
    this.sessionProgress = new SessionProgressStore(this.db);
    this.events = new EventStore(this.db);
    this.phases = new PhaseStore(this.db);
    this.issues = new IssueStore(this.db);
    this.artifacts = new ArtifactStore(this.db);
    this.reviewScopes = new ReviewScopeStore(this.db);
    this.reviewAttempts = new ReviewAttemptStore(this.db);
    this.executionTasks = new ExecutionTaskStore(this.db);
  }

  private migrateSchema(): void {
    if (!hasColumn(this.db, "sessions", "transcript_path")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
    }

    if (!tableSql(this.db, "session_progress")) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS session_progress (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id),
          execution_task_id TEXT REFERENCES execution_tasks(id),
          transcript_path TEXT,
          transcript_size INTEGER NOT NULL DEFAULT 0,
          last_output_at TEXT,
          last_activity_at TEXT,
          last_activity_kind TEXT CHECK(last_activity_kind IS NULL OR last_activity_kind IN ('read','write','search','bash','workflow','other')),
          last_activity_summary TEXT,
          last_tool_name TEXT,
          tool_use_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0,
          recent_activities_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_session_progress_run ON session_progress(run_id);
      `);
    }

    const messagesSql = tableSql(this.db, "messages").toLowerCase();
    if (messagesSql && (!messagesSql.includes("'worker_notification'") || messagesSql.includes("'worker_done'") || messagesSql.includes("'result'") || messagesSql.includes("'merge_ready'") || messagesSql.includes("'escalation'") || messagesSql.includes("'error'"))) {
      this.rebuildMessagesTable();
    }

    const artifactsSql = tableSql(this.db, "artifacts").toLowerCase();
    if (artifactsSql && !artifactsSql.includes("'prompt-contract'")) {
      this.rebuildArtifactsTable();
    }

    const executionTasksSql = tableSql(this.db, "execution_tasks").toLowerCase();
    if (executionTasksSql && (!executionTasksSql.includes("parent_task_id") || !executionTasksSql.includes("'superseded'") || !executionTasksSql.includes("'blocked'") || !executionTasksSql.includes("process_id") || !executionTasksSql.includes("last_output_at"))) {
      this.rebuildExecutionTasksTable();
    }

    if (!hasColumn(this.db, "execution_tasks", "executor")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'agent'");
      this.db.exec(`
        UPDATE execution_tasks
        SET executor = CASE
          WHEN capability = 'shell' THEN 'shell'
          WHEN capability = 'system' THEN 'system'
          ELSE 'agent'
        END
      `);
    }

    if (!hasColumn(this.db, "execution_tasks", "result_path")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN result_path TEXT");
      this.db.exec("UPDATE execution_tasks SET result_path = output_path WHERE output_path IS NOT NULL AND result_path IS NULL");
      this.db.exec("UPDATE execution_tasks SET output_path = NULL WHERE result_path IS NOT NULL");
    }

    if (!hasColumn(this.db, "execution_tasks", "parent_task_id")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN parent_task_id TEXT REFERENCES execution_tasks(id)");
    }

    if (!hasColumn(this.db, "execution_tasks", "output_offset")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN output_offset INTEGER NOT NULL DEFAULT 0");
    }

    if (!hasColumn(this.db, "execution_tasks", "notified")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN notified INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE execution_tasks
        SET notified = CASE
          WHEN status IN ('completed','failed') THEN 1
          ELSE 0
        END
      `);
    }

    if (!hasColumn(this.db, "execution_tasks", "notified_at")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN notified_at TEXT");
      this.db.exec(`
        UPDATE execution_tasks
        SET notified_at = CASE
          WHEN notified = 1 THEN COALESCE(completed_at, datetime('now'))
          ELSE NULL
        END
        WHERE notified_at IS NULL
      `);
    }

    if (!hasColumn(this.db, "execution_tasks", "head_sha")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN head_sha TEXT");
    }

    if (!hasColumn(this.db, "execution_tasks", "files_modified")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN files_modified TEXT");
    }

    if (!hasColumn(this.db, "execution_tasks", "control_state_json")) {
      this.db.exec("ALTER TABLE execution_tasks ADD COLUMN control_state_json TEXT NOT NULL DEFAULT '{}'");
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_execution_tasks_parent ON execution_tasks(parent_task_id)");
    this.backfillExecutionTaskControlState();
  }

  private rebuildMessagesTable(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE messages_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          subject TEXT NOT NULL DEFAULT '',
          body TEXT,
          type TEXT NOT NULL CHECK(type IN ('status','worker_notification')),
          priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
          thread_id TEXT,
          payload TEXT,
          run_id TEXT REFERENCES runs(id),
          read INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      this.db.exec(`
        INSERT INTO messages_new (id, from_agent, to_agent, subject, body, type, priority, thread_id, payload, run_id, read, created_at)
        SELECT
          id,
          from_agent,
          to_agent,
          subject,
          body,
          CASE
            WHEN type = 'worker_notification' THEN 'worker_notification'
            ELSE 'status'
          END,
          priority,
          thread_id,
          payload,
          run_id,
          read,
          created_at
        FROM messages;
      `);

      this.db.exec("DROP TABLE messages");
      this.db.exec("ALTER TABLE messages_new RENAME TO messages");
      this.db.exec(messageIndexSql());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private rebuildArtifactsTable(): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE artifacts_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          feature TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('plan','prompt-contract','contract','checkpoint','review-scope','review-report','grading-report','verify-report','merge-record','ship-report')),
          path TEXT NOT NULL,
          hash TEXT NOT NULL,
          issue_id TEXT REFERENCES issues(id),
          session_id TEXT REFERENCES sessions(id),
          review_scope_id TEXT REFERENCES review_scopes(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      this.db.exec(`
        INSERT INTO artifacts_new (id, run_id, feature, type, path, hash, issue_id, session_id, review_scope_id, created_at)
        SELECT
          id,
          run_id,
          feature,
          type,
          path,
          hash,
          issue_id,
          session_id,
          review_scope_id,
          created_at
        FROM artifacts;
      `);

      this.db.exec("DROP TABLE artifacts");
      this.db.exec("ALTER TABLE artifacts_new RENAME TO artifacts");
      this.db.exec(artifactIndexSql());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private rebuildExecutionTasksTable(): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    this.db.exec(`
      CREATE TABLE execution_tasks_new (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        issue_id TEXT REFERENCES issues(id),
        review_scope_id TEXT REFERENCES review_scopes(id),
        parent_task_id TEXT REFERENCES execution_tasks_new(id),
        logical_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('build','contract_review','implementation_review','merge','verify')),
        capability TEXT NOT NULL CHECK(capability IN ('builder','evaluator','system','shell')),
        executor TEXT NOT NULL CHECK(executor IN ('agent','shell','system')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','blocked','completed','failed','superseded')),
        active_session_id TEXT REFERENCES sessions(id),
        summary TEXT,
        output_path TEXT,
        result_path TEXT,
        head_sha TEXT,
        files_modified TEXT,
        command TEXT,
        cwd TEXT,
        process_id INTEGER,
        exit_code INTEGER,
        output_size INTEGER NOT NULL DEFAULT 0,
        last_output_at TEXT,
        output_offset INTEGER NOT NULL DEFAULT 0,
        notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1)),
        notified_at TEXT,
        last_error TEXT,
        control_state_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT
      );
    `);

    const executionTaskColumns = this.db.prepare("PRAGMA table_info(execution_tasks)").all() as Array<{ name: string }>;
    const hasParentTaskId = executionTaskColumns.some((column) => column.name === "parent_task_id");
    const hasExecutor = executionTaskColumns.some((column) => column.name === "executor");
    const hasResultPath = executionTaskColumns.some((column) => column.name === "result_path");
    const hasHeadSha = executionTaskColumns.some((column) => column.name === "head_sha");
    const hasFilesModified = executionTaskColumns.some((column) => column.name === "files_modified");
    const hasCommand = executionTaskColumns.some((column) => column.name === "command");
    const hasCwd = executionTaskColumns.some((column) => column.name === "cwd");
    const hasProcessId = executionTaskColumns.some((column) => column.name === "process_id");
    const hasExitCode = executionTaskColumns.some((column) => column.name === "exit_code");
    const hasOutputSize = executionTaskColumns.some((column) => column.name === "output_size");
    const hasLastOutputAt = executionTaskColumns.some((column) => column.name === "last_output_at");
    const hasOutputOffset = executionTaskColumns.some((column) => column.name === "output_offset");
    const hasNotified = executionTaskColumns.some((column) => column.name === "notified");
    const hasNotifiedAt = executionTaskColumns.some((column) => column.name === "notified_at");
    const hasControlStateJson = executionTaskColumns.some((column) => column.name === "control_state_json");
    const selectParentTaskId = hasParentTaskId ? "parent_task_id" : "NULL AS parent_task_id";
    const selectExecutor = hasExecutor
      ? "executor"
      : `CASE
          WHEN capability = 'shell' THEN 'shell'
          WHEN capability = 'system' THEN 'system'
          ELSE 'agent'
        END`;
    const selectOutputPath = hasResultPath ? "output_path" : "NULL";
    const selectResultPath = hasResultPath ? "result_path" : "output_path";
    const selectHeadSha = hasHeadSha ? "head_sha" : "NULL";
    const selectFilesModified = hasFilesModified ? "files_modified" : "NULL";
    const selectCommand = hasCommand ? "command" : "NULL";
    const selectCwd = hasCwd ? "cwd" : "NULL";
    const selectProcessId = hasProcessId ? "process_id" : "NULL";
    const selectExitCode = hasExitCode ? "exit_code" : "NULL";
    const selectOutputSize = hasOutputSize ? "output_size" : "0";
    const selectLastOutputAt = hasLastOutputAt ? "last_output_at" : "NULL";
    const selectOutputOffset = hasOutputOffset ? "output_offset" : "0";
    const selectNotified = hasNotified
      ? "notified"
      : `CASE
          WHEN status IN ('completed','failed') THEN 1
          ELSE 0
        END`;
    const selectNotifiedAt = hasNotifiedAt
      ? "notified_at"
      : `CASE
          WHEN status IN ('completed','failed') THEN COALESCE(completed_at, datetime('now'))
          ELSE NULL
        END`;
    const selectControlStateJson = hasControlStateJson ? "control_state_json" : "'{}'";

    this.db.exec(`
      INSERT INTO execution_tasks_new (
        id, run_id, issue_id, review_scope_id, parent_task_id, logical_name, kind, capability, executor, status,
        active_session_id, summary, output_path, result_path, head_sha, files_modified, command, cwd, process_id, exit_code, output_size, last_output_at, output_offset, notified, notified_at, last_error, control_state_json,
        created_at, updated_at, completed_at
      )
      SELECT
        id,
        run_id,
        issue_id,
        review_scope_id,
        ${selectParentTaskId},
        logical_name,
        kind,
        capability,
        ${selectExecutor},
        CASE
          WHEN status IN ('pending','running','blocked','completed','failed','superseded') THEN status
          ELSE 'failed'
        END,
        active_session_id,
        summary,
        ${selectOutputPath},
        ${selectResultPath},
        ${selectHeadSha},
        ${selectFilesModified},
        ${selectCommand},
        ${selectCwd},
        ${selectProcessId},
        ${selectExitCode},
        ${selectOutputSize},
        ${selectLastOutputAt},
        ${selectOutputOffset},
        ${selectNotified},
        ${selectNotifiedAt},
        last_error,
        ${selectControlStateJson},
        created_at,
        updated_at,
        completed_at
      FROM execution_tasks;
    `);

    this.db.exec("DROP TABLE execution_tasks");
    this.db.exec("ALTER TABLE execution_tasks_new RENAME TO execution_tasks");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_execution_tasks_run_status ON execution_tasks(run_id, status)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_execution_tasks_issue ON execution_tasks(issue_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_execution_tasks_parent ON execution_tasks(parent_task_id)");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_tasks_run_logical ON execution_tasks(run_id, logical_name)");
    this.backfillExecutionTaskControlState();
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  private backfillExecutionTaskControlState(): void {
    const rows = this.db
      .prepare(
        `SELECT id, status, output_offset, notified, notified_at, control_state_json
         FROM execution_tasks`,
      )
      .all() as Array<
        Pick<
          ExecutionTaskRow,
          "id" | "status" | "output_offset" | "notified" | "notified_at" | "control_state_json"
        >
      >;

    const update = this.db.prepare(
      "UPDATE execution_tasks SET control_state_json = ? WHERE id = ?",
    );
    const backfill = this.db.transaction((tasks: typeof rows) => {
      for (const task of tasks) {
        let shouldBackfill = true;
        if (task.control_state_json) {
          try {
            shouldBackfill = !ExecutionTaskControlStateSchema.safeParse(
              JSON.parse(task.control_state_json),
            ).success;
          } catch {
            shouldBackfill = true;
          }
        }
        if (!shouldBackfill) {
          continue;
        }

        const nextState = deriveExecutionTaskControlStateFromMutation(
          {
            ...task,
            control_state_json: "",
          },
          {
            status: task.status,
            output_offset: task.output_offset,
            notified: task.notified,
            notified_at: task.notified_at,
          },
          task.notified_at ?? now(),
        );
        update.run(
          serializeExecutionTaskControlState(nextState),
          task.id,
        );
      }
    });

    backfill(rows);
  }

  close(): void {
    this.db.close();
  }
}
