import type { CnogDB } from "./db.js";
import type { Capability, ExecutionTaskKind, ExecutionTaskRow } from "./types.js";

export interface ExecutionTaskFilter {
  capability?: Capability;
  kind?: ExecutionTaskKind;
  reviewScopeId?: string;
}

export function listRunExecutionTasks(db: CnogDB, runId: string): ExecutionTaskRow[] {
  return db.executionTasks.list({ run_id: runId });
}

export function hasLegacyActiveSessions(
  db: CnogDB,
  runId: string,
  capability?: Capability,
): boolean {
  return db.sessions
    .list({ run_id: runId })
    .some((session) => (
      session.execution_task_id === null
      && (!capability || session.capability === capability)
      && (session.state === "booting" || session.state === "working")
    ));
}

export function executionTaskMatchesFilter(
  task: ExecutionTaskRow,
  filter?: ExecutionTaskFilter,
): boolean {
  return (!filter?.capability || task.capability === filter.capability)
    && (!filter?.kind || task.kind === filter.kind)
    && (!filter?.reviewScopeId || task.review_scope_id === filter.reviewScopeId);
}

export function findBlockedExecutionTask(
  db: CnogDB,
  runId: string,
  filter?: ExecutionTaskFilter,
): ExecutionTaskRow | null {
  return listRunExecutionTasks(db, runId).find((task) => (
    task.status === "blocked" && executionTaskMatchesFilter(task, filter)
  )) ?? null;
}

export function blockedExecutionTaskReason(task: ExecutionTaskRow): string {
  return task.summary ?? task.last_error ?? `${task.logical_name} is blocked`;
}

export function hasRunningExecutionTasks(
  db: CnogDB,
  runId: string,
  filter?: ExecutionTaskFilter,
): boolean {
  return listRunExecutionTasks(db, runId).some((task) => (
    task.status === "running" && executionTaskMatchesFilter(task, filter)
  ));
}

export function hasInFlightRunWork(
  db: CnogDB,
  runId: string,
  filter?: ExecutionTaskFilter,
): boolean {
  return hasRunningExecutionTasks(db, runId, filter)
    || hasLegacyActiveSessions(db, runId, filter?.capability);
}

export function findBlockedIssueVerificationTask(
  db: CnogDB,
  runId: string,
): ExecutionTaskRow | null {
  return listRunExecutionTasks(db, runId).find((task) => (
    task.kind === "verify" && task.issue_id !== null && task.status === "blocked"
  )) ?? null;
}

export function hasFailedScopeVerification(db: CnogDB, runId: string): boolean {
  const activeScope = db.reviewScopes.activeForRun(runId);
  if (!activeScope) {
    return false;
  }
  return listRunExecutionTasks(db, runId).some((task) => (
    task.kind === "verify"
    && task.review_scope_id === activeScope.id
    && task.status === "failed"
  ));
}
