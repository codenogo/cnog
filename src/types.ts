/**
 * Shared zod schemas and TypeScript types for the cnog orchestrator.
 *
 * Single canonical enum per concept. No duplicates, no deprecated shims.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (zod schemas + inferred types)
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.enum([
  "booting",
  "working",
  "completed",
  "stalled",
  "failed",
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const MessageTypeSchema = z.enum([
  "status",
  "result",
  "error",
  "worker_done",
  "merge_ready",
  "escalation",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const PrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export type Priority = z.infer<typeof PrioritySchema>;

export const MergeStatusSchema = z.enum([
  "pending",
  "merging",
  "merged",
  "conflict",
  "failed",
]);
export type MergeStatus = z.infer<typeof MergeStatusSchema>;

export const ResolveTierSchema = z.enum(["clean", "auto", "ai", "reimagine"]);
export type ResolveTier = z.infer<typeof ResolveTierSchema>;

export const RunPhaseSchema = z.enum([
  "plan",
  "contract",
  "build",
  "evaluate",
  "merge",
  "ship",
  "done",
  "failed",
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const IssueTypeSchema = z.enum(["epic", "task", "subtask", "bug"]);
export type IssueType = z.infer<typeof IssueTypeSchema>;

export const IssueStatusSchema = z.enum([
  "open",
  "in_progress",
  "done",
  "closed",
]);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const CapabilitySchema = z.enum([
  "planner",
  "builder",
  "evaluator",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const EventLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;

export const ArtifactTypeSchema = z.enum([
  "plan",
  "contract",
  "checkpoint",
  "review-scope",
  "review-report",
  "grading-report",
  "verify-report",
  "merge-record",
  "ship-report",
]);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ScopeStatusSchema = z.enum([
  "pending",
  "evaluating",
  "approved",
  "rejected",
  "stale",
]);
export type ScopeStatus = z.infer<typeof ScopeStatusSchema>;

export const ContractStatusSchema = z.enum([
  "proposed",
  "pending_review",
  "accepted",
  "rejected",
  "completed",
  "failed",
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;

// ---------------------------------------------------------------------------
// Row interfaces
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  name: string;
  logical_name: string;
  attempt: number;
  runtime: string;
  capability: string;
  feature: string | null;
  task_id: string | null;
  worktree_path: string | null;
  branch: string | null;
  tmux_session: string | null;
  pid: number | null;
  state: string;
  parent_agent: string | null;
  run_id: string;
  started_at: string;
  last_heartbeat: string | null;
  completed_at: string | null;
  error: string | null;
}

export interface MessageRow {
  id: number;
  from_agent: string;
  to_agent: string;
  subject: string;
  body: string | null;
  type: string;
  priority: string;
  thread_id: string | null;
  payload: string | null;
  run_id: string | null;
  read: number;
  created_at: string;
}

export interface MergeQueueRow {
  id: number;
  feature: string;
  branch: string;
  agent_name: string;
  run_id: string;
  session_id: string;
  task_id: string | null;
  head_sha: string;
  files_modified: string | null;
  status: string;
  resolved_tier: string | null;
  enqueued_at: string;
  merged_at: string | null;
}

export interface RunRow {
  id: string;
  feature: string;
  plan_number: string | null;
  status: string;
  phase_reason: string | null;
  profile: string | null;
  tasks: string | null;
  review: string | null;
  ship: string | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetricRow {
  id: number;
  agent_name: string;
  feature: string;
  run_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  recorded_at: string;
}

export interface EventRow {
  id: number;
  timestamp: string;
  level: string;
  source: string;
  event_type: string;
  agent_name: string | null;
  feature: string | null;
  message: string;
  data: string | null;
}

/**
 * Derived projection only. No business logic should read from this as authority.
 * All authoritative state lives on runs.
 */
export interface FeaturePhaseRow {
  feature: string;
  phase: string;
  review_verdict: string | null;
  profile: string | null;
  updated_at: string;
}

export interface IssueRow {
  id: string;
  title: string;
  description: string | null;
  issue_type: string;
  status: string;
  priority: number;
  assignee: string | null;
  feature: string | null;
  run_id: string;
  plan_number: string | null;
  phase: string | null;
  parent_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface IssueDepRow {
  issue_id: string;
  depends_on: string;
}

export interface IssueEventRow {
  id: number;
  issue_id: string;
  event_type: string;
  actor: string | null;
  data: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Artifact registry
// ---------------------------------------------------------------------------

export interface ArtifactRow {
  id: string;
  run_id: string;
  feature: string;
  type: string;
  path: string;
  hash: string;
  issue_id: string | null;
  session_id: string | null;
  review_scope_id: string | null;
  created_at: string;
}

export interface ReviewScopeRow {
  id: string;
  run_id: string;
  scope_status: string;
  scope_hash: string;
  merge_entries: string;
  branches: string;
  head_shas: string;
  contract_ids: string;
  contract_hashes: string;
  verify_commands: string;
  verdict: string | null;
  evaluator_session: string | null;
  created_at: string;
  evaluated_at: string | null;
}

export interface ReviewAttemptRow {
  id: number;
  scope_id: string;
  evaluator_session: string;
  verdict: string;
  report_artifact_id: string | null;
  grading_artifact_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ---------------------------------------------------------------------------
// Checkpoint + Handoff (context resets)
// ---------------------------------------------------------------------------

export const HandoffReasonSchema = z.enum([
  "compaction",
  "crash",
  "manual",
  "timeout",
  "completed",
]);
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;

export interface SessionCheckpoint {
  agentName: string;
  logicalName: string;
  runId: string;
  feature: string;
  taskId: string;
  sessionId: string;
  timestamp: string;
  progressSummary: string;
  filesModified: string[];
  currentBranch: string;
  pendingWork: string;
  verifyResults: Record<string, boolean>;
}

export interface SessionHandoff {
  fromSessionId: string;
  toSessionId: string | null;
  checkpoint: SessionCheckpoint;
  reason: HandoffReason;
  handoffAt: string;
}

// ---------------------------------------------------------------------------
// Grading rubric (structured evaluation)
// ---------------------------------------------------------------------------

export interface GradingCriterion {
  name: string;
  description: string;
  weight: number;
  threshold: number;
}

export interface GradingRubric {
  criteria: GradingCriterion[];
  passThreshold: number;
}

export interface GradeResult {
  criterion: string;
  score: number;
  weight: number;
  threshold: number;
  passed: boolean;
  feedback: string;
}

export interface GradingReport {
  taskId: string;
  agentName: string;
  feature: string;
  grades: GradeResult[];
  weightedScore: number;
  passed: boolean;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCK";
  summary: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Sprint contracts (acceptance negotiation)
// ---------------------------------------------------------------------------

export interface SprintContract {
  id: string;
  taskId: string;
  runId: string;
  feature: string;
  agentName: string;
  acceptanceCriteria: AcceptanceCriterion[];
  verifyCommands: string[];
  fileScope: string[];
  status: ContractStatus;
  proposedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
}

export interface AcceptanceCriterion {
  description: string;
  testable: boolean;
  verifyCommand?: string;
}
