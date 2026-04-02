import type { CnogDB } from "./db.js";
import type { CnogConfig } from "./config.js";
import type { MergeQueueRow, RunRow, ExecutionTaskRow, SessionRow, SessionActivity } from "./types.js";
import type { Watchdog } from "./watchdog.js";
import type { SessionHealth } from "./watchdog-policy.js";
import { parseExecutionTaskControlState } from "./execution-task-state.js";
import { listRuntimes } from "./runtimes/index.js";
import { selectExecutionTaskAttempt } from "./task-runtime.js";

export interface AgentStatus {
  name: string;
  runtime: string;
  capability: string;
  state: string;
  feature: string | null;
  branch: string | null;
  runId: string;
  lastHeartbeat: string | null;
  transcriptPath: string | null;
  taskLogPath: string | null;
  durationMs: number | null;
  toolUseCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  progressSummary: string | null;
  lastActivityAt: string | null;
  lastActivityKind: string | null;
  lastActivitySummary: string | null;
  recentActivities: SessionActivity[];
  health: SessionHealth["decision"]["kind"];
  healthReason: string | null;
}

export interface RunStatus {
  id: string;
  feature: string;
  phase: string;
  phaseReason: string | null;
  profile: string | null;
  artifactCount: number;
  activeScopeStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureStatus {
  feature: string;
  phase: string;
  reviewVerdict: string | null;
  profile: string | null;
}

export interface ExecutionTaskStatus {
  id: string;
  logicalName: string;
  kind: string;
  capability: string;
  executor: string;
  status: string;
  feature: string;
  runId: string;
  issueId: string | null;
  issueTitle: string | null;
  reviewScopeId: string | null;
  parentTaskId: string | null;
  selectedSession: string | null;
  selectedAttempt: number | null;
  selectedReason: "active" | "latest" | "none";
  attemptCount: number;
  summary: string | null;
  outputPath: string | null;
  resultPath: string | null;
  transcriptPath: string | null;
  lastError: string | null;
  notified: boolean;
  notificationDelivery: string;
  notificationSequence: number;
  backgrounded: boolean;
  retained: boolean;
  pendingMessageCount: number;
  toolUseCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastActivityAt: string | null;
  lastActivityKind: string | null;
  lastActivitySummary: string | null;
  recentActivities: SessionActivity[];
  stallKind: string;
  stallReason: string | null;
  stallDetectedAt: string | null;
  stallNudgeCount: number;
  updatedAt: string;
  completedAt: string | null;
}

export interface StatusSnapshot {
  summary: {
    configuredRuntime: string;
    availableRuntimes: string[];
    activeAgents: number;
    activeTasks: number;
    blockedTasks: number;
    failedTasks: number;
    activeRuns: number;
    pendingMerges: number;
    mergeConflicts: number;
    unreadMail: number;
    trackedFeatures: number;
  };
  agents: AgentStatus[];
  tasks: ExecutionTaskStatus[];
  runs: RunStatus[];
  merges: MergeQueueRow[];
  features: FeatureStatus[];
  health: SessionHealth[];
}

function durationMs(startedAt: string, completedAt?: string | null): number | null {
  const start = Date.parse(startedAt.replace(" ", "T"));
  if (Number.isNaN(start)) return null;
  const end = completedAt ? Date.parse(completedAt.replace(" ", "T")) : Date.now();
  if (Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function toAgentStatus(session: SessionRow, db: CnogDB, health: SessionHealth | undefined): AgentStatus {
  const progress = db.sessionProgress.get(session.id);
  const taskLogPath = session.execution_task_id
    ? db.executionTasks.get(session.execution_task_id)?.output_path ?? null
    : null;
  const progressSummary = progress?.last_activity_summary
    ?? (taskLogPath ? `Working against ${taskLogPath}` : null);
  return {
    name: session.name,
    runtime: session.runtime,
    capability: session.capability,
    state: session.state,
    feature: session.feature,
    branch: session.branch,
    runId: session.run_id,
    lastHeartbeat: session.last_heartbeat,
    transcriptPath: session.transcript_path,
    taskLogPath,
    durationMs: durationMs(session.started_at, session.completed_at),
    toolUseCount: progress?.tool_use_count ?? 0,
    inputTokens: progress?.input_tokens ?? 0,
    outputTokens: progress?.output_tokens ?? 0,
    costUsd: progress?.cost_usd ?? 0,
    progressSummary,
    lastActivityAt: progress?.last_activity_at ?? null,
    lastActivityKind: progress?.last_activity_kind ?? null,
    lastActivitySummary: progress?.last_activity_summary ?? null,
    recentActivities: progress
      ? JSON.parse(progress.recent_activities_json) as SessionActivity[]
      : [],
    health: health?.decision.kind ?? "healthy",
    healthReason: health?.decision.reason ?? null,
  };
}

function toRunStatus(run: RunRow, db: CnogDB): RunStatus {
  const artifacts = db.artifacts.listByRun(run.id);
  const activeScope = db.reviewScopes.activeForRun(run.id);
  return {
    id: run.id,
    feature: run.feature,
    phase: run.status,
    phaseReason: run.phase_reason,
    profile: run.profile,
    artifactCount: artifacts.length,
    activeScopeStatus: activeScope?.scope_status ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function buildFeatureStatuses(db: CnogDB): FeatureStatus[] {
  const runs = db.db.prepare(
    "SELECT * FROM runs ORDER BY created_at DESC, rowid DESC",
  ).all() as RunRow[];
  const latestByFeature = new Map<string, RunRow>();

  for (const run of runs) {
    if (!latestByFeature.has(run.feature)) {
      latestByFeature.set(run.feature, run);
    }
  }

  return [...latestByFeature.values()]
    .sort((a, b) => a.feature.localeCompare(b.feature))
    .map((run) => {
      const latestScope = db.reviewScopes.activeForRun(run.id)
        ?? db.reviewScopes.listByRun(run.id)[0];
      return {
        feature: run.feature,
        phase: run.status,
        reviewVerdict: latestScope?.verdict ?? null,
        profile: run.profile,
      };
    });
}

function taskStatusRank(status: string): number {
  switch (status) {
    case "running":
      return 0;
    case "blocked":
      return 1;
    case "pending":
      return 2;
    case "failed":
      return 3;
    case "superseded":
      return 4;
    case "completed":
      return 5;
    default:
      return 6;
  }
}

function shouldIncludeTask(task: ExecutionTaskRow): boolean {
  if (task.status !== "completed") {
    return true;
  }
  return !!task.result_path || !!task.last_error;
}

function toExecutionTaskStatus(
  task: ExecutionTaskRow,
  db: CnogDB,
  runsById: Map<string, RunRow>,
): ExecutionTaskStatus {
  const run = runsById.get(task.run_id);
  const issue = task.issue_id ? db.issues.get(task.issue_id) : undefined;
  const selectedAttempt = selectExecutionTaskAttempt(db, task);
  const session = selectedAttempt.session;
  const controlState = parseExecutionTaskControlState(task.control_state_json, task.status);

  return {
    id: task.id,
    logicalName: task.logical_name,
    kind: task.kind,
    capability: task.capability,
    executor: task.executor,
    status: task.status,
    feature: run?.feature ?? "-",
    runId: task.run_id,
    issueId: task.issue_id,
    issueTitle: issue?.title ?? null,
    reviewScopeId: task.review_scope_id,
    parentTaskId: task.parent_task_id,
    selectedSession: session?.name ?? null,
    selectedAttempt: session?.attempt ?? null,
    selectedReason: selectedAttempt.reason,
    attemptCount: selectedAttempt.attemptCount,
    summary: task.summary,
    outputPath: task.output_path,
    resultPath: task.result_path,
    transcriptPath: session?.transcript_path ?? null,
    lastError: task.last_error,
    notified: task.notified === 1,
    notificationDelivery: controlState.notification.delivery,
    notificationSequence: controlState.notification.sequence,
    backgrounded: controlState.backgrounded,
    retained: controlState.retained,
    pendingMessageCount: controlState.pendingMessages.length,
    toolUseCount: controlState.progress.toolUseCount,
    inputTokens: controlState.progress.inputTokens,
    outputTokens: controlState.progress.outputTokens,
    costUsd: controlState.progress.costUsd,
    lastActivityAt: controlState.progress.lastActivityAt,
    lastActivityKind: controlState.progress.lastActivityKind,
    lastActivitySummary: controlState.progress.lastActivitySummary,
    recentActivities: controlState.progress.recentActivities,
    stallKind: controlState.stall.kind,
    stallReason: controlState.stall.reason,
    stallDetectedAt: controlState.stall.detectedAt,
    stallNudgeCount: controlState.stall.nudgeCount,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  };
}

export function buildExecutionTaskStatuses(
  db: CnogDB,
  runs: RunRow[],
): ExecutionTaskStatus[] {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const runIds = new Set(runs.map((run) => run.id));

  return db.executionTasks
    .list()
    .filter((task) => runIds.has(task.run_id) && shouldIncludeTask(task))
    .sort((a, b) => {
      const rankDiff = taskStatusRank(a.status) - taskStatusRank(b.status);
      if (rankDiff !== 0) return rankDiff;
      return b.updated_at.localeCompare(a.updated_at);
    })
    .map((task) => toExecutionTaskStatus(task, db, runsById));
}

export function buildStatusSnapshot(
  db: CnogDB,
  config: CnogConfig,
  watchdog: Watchdog,
): StatusSnapshot {
  const health = watchdog.inspectActive();
  const healthByAgent = new Map(health.map((entry) => [entry.observation.session.name, entry]));
  const activeAgents = db.sessions.active();
  const merges = db.merges.list();
  const features = buildFeatureStatuses(db);

  // Get active runs (non-terminal)
  const activeRuns = db.db.prepare(
    "SELECT * FROM runs WHERE status NOT IN ('done','failed') ORDER BY created_at DESC",
  ).all() as RunRow[];
  const tasks = buildExecutionTaskStatuses(db, activeRuns);

  const unreadMail = db.messages.checkMail("orchestrator");

  return {
    summary: {
      configuredRuntime: config.agents.runtime,
      availableRuntimes: listRuntimes(),
      activeAgents: activeAgents.length,
      activeTasks: tasks.filter((task) => task.status === "pending" || task.status === "running").length,
      blockedTasks: tasks.filter((task) => task.status === "blocked").length,
      failedTasks: tasks.filter((task) => task.status === "failed").length,
      activeRuns: activeRuns.length,
      pendingMerges: merges.filter((entry) => entry.status === "pending").length,
      mergeConflicts: merges.filter((entry) => entry.status === "conflict").length,
      unreadMail: unreadMail.length,
      trackedFeatures: features.length,
    },
    agents: activeAgents.map((session) => toAgentStatus(session, db, healthByAgent.get(session.name))),
    tasks,
    runs: activeRuns.map((run) => toRunStatus(run, db)),
    merges,
    features,
    health,
  };
}
