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
  "worker_notification",
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
  "prompt-contract",
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

export const ExecutionTaskKindSchema = z.enum([
  "build",
  "contract_review",
  "implementation_review",
  "merge",
  "verify",
]);
export type ExecutionTaskKind = z.infer<typeof ExecutionTaskKindSchema>;

export const ExecutionTaskExecutorSchema = z.enum([
  "agent",
  "shell",
  "system",
]);
export type ExecutionTaskExecutor = z.infer<typeof ExecutionTaskExecutorSchema>;

export const ExecutionTaskStatusSchema = z.enum([
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "superseded",
]);
export type ExecutionTaskStatus = z.infer<typeof ExecutionTaskStatusSchema>;

export const ReviewVerdictSchema = z.enum([
  "APPROVE",
  "REQUEST_CHANGES",
  "BLOCK",
]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const ReworkPhaseSchema = z.enum(["build", "contract"]);
export type ReworkPhase = z.infer<typeof ReworkPhaseSchema>;

export const ContractDecisionSchema = z.enum(["ACCEPT", "REJECT"]);
export type ContractDecision = z.infer<typeof ContractDecisionSchema>;

export const WorkerExecutionKindSchema = z.enum([
  "build",
  "contract_review",
  "implementation_review",
  "plan",
  "generic",
]);
export type WorkerExecutionKind = z.infer<typeof WorkerExecutionKindSchema>;

export const WorkerNotificationStatusSchema = z.enum([
  "progress",
  "completed",
  "failed",
  "blocked",
  "killed",
]);
export type WorkerNotificationStatus = z.infer<typeof WorkerNotificationStatusSchema>;

export const SessionActivityKindSchema = z.enum([
  "read",
  "write",
  "search",
  "bash",
  "workflow",
  "other",
]);
export type SessionActivityKind = z.infer<typeof SessionActivityKindSchema>;

export const SessionActivitySchema = z.object({
  at: z.string(),
  kind: SessionActivityKindSchema,
  tool: z.string().nullable(),
  target: z.string().nullable(),
  summary: z.string(),
}).strict();
export type SessionActivityRecord = z.infer<typeof SessionActivitySchema>;

export const EscalationCodeSchema = z.enum([
  "scope_violation_required",
  "missing_dependency",
  "contract_incomplete",
  "verification_drift",
  "unexpected_repo_state",
  "external_blocker",
  "need_clarification",
]);
export type EscalationCode = z.infer<typeof EscalationCodeSchema>;

export const ScorePayloadSchema = z.object({
  criterion: z.string(),
  score: z.number(),
  feedback: z.string(),
}).strict();
export type ScorePayload = z.infer<typeof ScorePayloadSchema>;

export const ContractReviewDecisionPayloadSchema = z.object({
  contractId: z.string(),
  decision: ContractDecisionSchema,
  notes: z.string().optional(),
}).strict();
export type ContractReviewDecisionPayload = z.infer<typeof ContractReviewDecisionPayloadSchema>;

export const BuilderCompletionDataSchema = z.object({
  kind: z.literal("builder_completion"),
  headSha: z.string().optional(),
  filesModified: z.array(z.string()).default([]),
}).strict();
export type BuilderCompletionData = z.infer<typeof BuilderCompletionDataSchema>;

export const PlannerCompletionDataSchema = z.object({
  kind: z.literal("planner_completion"),
  planPath: z.string(),
  taskCount: z.number().int().nonnegative(),
  planHash: z.string().optional(),
}).strict();
export type PlannerCompletionData = z.infer<typeof PlannerCompletionDataSchema>;

export const GenericCompletionDataSchema = z.object({
  kind: z.literal("generic_completion"),
  role: CapabilitySchema,
}).strict();
export type GenericCompletionData = z.infer<typeof GenericCompletionDataSchema>;

export const ContractReviewDataSchema = z.object({
  kind: z.literal("contract_review"),
  contracts: z.array(ContractReviewDecisionPayloadSchema).min(1),
}).strict();
export type ContractReviewData = z.infer<typeof ContractReviewDataSchema>;

export const ImplementationReviewDataSchema = z.object({
  kind: z.literal("implementation_review"),
  scopeId: z.string(),
  scopeHash: z.string(),
  verdict: ReviewVerdictSchema,
  reworkPhase: ReworkPhaseSchema.optional(),
  scores: z.array(ScorePayloadSchema).min(1),
}).strict();
export type ImplementationReviewData = z.infer<typeof ImplementationReviewDataSchema>;

export const EscalationDataSchema = z.object({
  kind: z.literal("escalation"),
  role: CapabilitySchema,
  code: EscalationCodeSchema,
  evidence: z.array(z.string()).default([]),
  requestedAction: z.string().optional(),
}).strict();
export type EscalationData = z.infer<typeof EscalationDataSchema>;

export const WorkerNotificationDataSchema = z.discriminatedUnion("kind", [
  BuilderCompletionDataSchema,
  PlannerCompletionDataSchema,
  GenericCompletionDataSchema,
  ContractReviewDataSchema,
  ImplementationReviewDataSchema,
  EscalationDataSchema,
]);
export type WorkerNotificationData = z.infer<typeof WorkerNotificationDataSchema>;

export const WorkerRunContextSchema = z.object({
  id: z.string(),
  feature: z.string(),
}).strict();
export type WorkerRunContext = z.infer<typeof WorkerRunContextSchema>;

export const WorkerActorContextSchema = z.object({
  agentName: z.string(),
  logicalName: z.string(),
  attempt: z.number().int().positive(),
  capability: CapabilitySchema,
  runtime: z.string(),
  sessionId: z.string(),
}).strict();
export type WorkerActorContext = z.infer<typeof WorkerActorContextSchema>;

export const WorkerTaskContextSchema = z.object({
  executionTaskId: z.string().optional(),
  logicalName: z.string().optional(),
  kind: ExecutionTaskKindSchema.optional(),
  executor: ExecutionTaskExecutorSchema.optional(),
  issueId: z.string().optional(),
  reviewScopeId: z.string().optional(),
  scopeHash: z.string().optional(),
}).strict();
export type WorkerTaskContext = z.infer<typeof WorkerTaskContextSchema>;

export const WorkerOutputContextSchema = z.object({
  taskLogPath: z.string().optional(),
  resultPath: z.string().optional(),
  transcriptPath: z.string().optional(),
}).strict();
export type WorkerOutputContext = z.infer<typeof WorkerOutputContextSchema>;

export const WorkerWorktreeContextSchema = z.object({
  path: z.string().optional(),
  branch: z.string().optional(),
  headSha: z.string().optional(),
  filesModified: z.array(z.string()).optional(),
}).strict();
export type WorkerWorktreeContext = z.infer<typeof WorkerWorktreeContextSchema>;

export const WorkerUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  toolUses: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
}).strict();
export type WorkerUsage = z.infer<typeof WorkerUsageSchema>;

export const WorkerNotificationPayloadSchema = z.object({
  protocolVersion: z.literal(2),
  kind: z.literal("worker_notification"),
  status: WorkerNotificationStatusSchema,
  summary: z.string(),
  run: WorkerRunContextSchema,
  actor: WorkerActorContextSchema,
  task: WorkerTaskContextSchema,
  output: WorkerOutputContextSchema,
  worktree: WorkerWorktreeContextSchema.optional(),
  usage: WorkerUsageSchema.optional(),
  data: WorkerNotificationDataSchema,
}).strict();
export type WorkerNotificationPayload = z.infer<typeof WorkerNotificationPayloadSchema>;

export const ExecutionTaskNotificationDeliverySchema = z.enum([
  "idle",
  "pending",
  "delivered",
]);
export type ExecutionTaskNotificationDelivery = z.infer<typeof ExecutionTaskNotificationDeliverySchema>;

export const ExecutionTaskTerminalStatusSchema = z.enum([
  "completed",
  "failed",
  "superseded",
]);
export type ExecutionTaskTerminalStatus = z.infer<typeof ExecutionTaskTerminalStatusSchema>;

export const ExecutionTaskStallKindSchema = z.enum([
  "healthy",
  "stalled",
  "waiting_input",
  "blocked",
]);
export type ExecutionTaskStallKind = z.infer<typeof ExecutionTaskStallKindSchema>;

export const ExecutionTaskLifecycleStateSchema = z.object({
  currentStatus: ExecutionTaskStatusSchema,
  transitionCount: z.number().int().nonnegative(),
  reopenedCount: z.number().int().nonnegative(),
  terminalCount: z.number().int().nonnegative(),
}).strict();
export type ExecutionTaskLifecycleState = z.infer<typeof ExecutionTaskLifecycleStateSchema>;

export const ExecutionTaskNotificationStateSchema = z.object({
  sequence: z.number().int().nonnegative(),
  delivery: ExecutionTaskNotificationDeliverySchema,
  lastTerminalStatus: ExecutionTaskTerminalStatusSchema.nullable(),
  lastEnqueuedAt: z.string().nullable(),
  lastDeliveredAt: z.string().nullable(),
  lastOutputOffset: z.number().int().nonnegative(),
}).strict();
export type ExecutionTaskNotificationState = z.infer<typeof ExecutionTaskNotificationStateSchema>;

export const ExecutionTaskProgressStateSchema = z.object({
  toolUseCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  lastActivityAt: z.string().nullable(),
  lastActivityKind: SessionActivityKindSchema.nullable(),
  lastActivitySummary: z.string().nullable(),
  recentActivities: z.array(SessionActivitySchema),
}).strict();
export type ExecutionTaskProgressState = z.infer<typeof ExecutionTaskProgressStateSchema>;

export const ExecutionTaskStallStateSchema = z.object({
  kind: ExecutionTaskStallKindSchema,
  reason: z.string().nullable(),
  detectedAt: z.string().nullable(),
  nudgeCount: z.number().int().nonnegative(),
}).strict();
export type ExecutionTaskStallState = z.infer<typeof ExecutionTaskStallStateSchema>;

export const ExecutionTaskControlStateSchema = z.object({
  schemaVersion: z.literal(1),
  backgrounded: z.boolean(),
  retained: z.boolean(),
  pendingMessages: z.array(z.string()),
  lifecycle: ExecutionTaskLifecycleStateSchema,
  notification: ExecutionTaskNotificationStateSchema,
  progress: ExecutionTaskProgressStateSchema,
  stall: ExecutionTaskStallStateSchema,
}).strict();
export type ExecutionTaskControlState = z.infer<typeof ExecutionTaskControlStateSchema>;

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
  execution_task_id: string | null;
  worktree_path: string | null;
  transcript_path: string | null;
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

export interface SessionActivity {
  at: string;
  kind: SessionActivityKind;
  tool: string | null;
  target: string | null;
  summary: string;
}

export interface SessionProgressRow {
  session_id: string;
  run_id: string;
  execution_task_id: string | null;
  transcript_path: string | null;
  transcript_size: number;
  last_output_at: string | null;
  last_activity_at: string | null;
  last_activity_kind: SessionActivityKind | null;
  last_activity_summary: string | null;
  last_tool_name: string | null;
  tool_use_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  recent_activities_json: string;
  updated_at: string;
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

export interface ExecutionTaskRow {
  id: string;
  run_id: string;
  issue_id: string | null;
  review_scope_id: string | null;
  parent_task_id: string | null;
  logical_name: string;
  kind: string;
  capability: string;
  executor: string;
  status: string;
  active_session_id: string | null;
  summary: string | null;
  output_path: string | null;
  result_path: string | null;
  head_sha: string | null;
  files_modified: string | null;
  command: string | null;
  cwd: string | null;
  process_id: number | null;
  exit_code: number | null;
  output_size: number;
  last_output_at: string | null;
  output_offset: number;
  notified: number;
  notified_at: string | null;
  last_error: string | null;
  control_state_json: string;
  created_at: string;
  updated_at: string;
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

export interface SessionCheckpointScratchpad {
  shared: string | null;
  role: string | null;
  agent: string | null;
}

export interface SessionCheckpointResumeContext {
  transcriptPath: string | null;
  taskLogPath: string | null;
  transcriptTail: string | null;
  taskLogTail: string | null;
  lastActivityAt: string | null;
  lastActivitySummary: string | null;
  toolUseCount: number;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recentActivities: SessionActivity[];
  scratchpad: SessionCheckpointScratchpad;
}

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
  resumeContext: SessionCheckpointResumeContext;
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
