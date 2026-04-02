import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import type { CnogDB } from "./db.js";
import type { ExecutionTaskRow, RunRow, SessionRow } from "./types.js";
import * as tmux from "./tmux.js";
import { cleanupReviewScopeVerifierWorktree } from "./verify-worktree.js";
import {
  executionTaskOutputRelativePath,
} from "./paths.js";

const MAX_NOTIFICATION_OUTPUT_CHARS = 32_000;

export interface SelectedTaskAttempt {
  session: SessionRow | null;
  reason: "active" | "latest" | "none";
  attemptCount: number;
}

export interface ExecutionTaskNotification {
  task: ExecutionTaskRow;
  run: RunRow;
  outputPath: string | null;
  resultPath: string | null;
  output: string | null;
}

function resolvePath(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

function taskRun(db: CnogDB, task: ExecutionTaskRow): RunRow {
  const run = db.runs.get(task.run_id);
  if (!run) {
    throw new Error(`Run ${task.run_id} not found for execution task ${task.id}`);
  }
  return run;
}

function taskOutputRelativePath(db: CnogDB, task: ExecutionTaskRow): string {
  const run = taskRun(db, task);
  return executionTaskOutputRelativePath(run.feature, run.id, task.id);
}

export function ensureExecutionTaskOutput(db: CnogDB, taskId: string, projectRoot: string): string {
  const task = db.executionTasks.get(taskId);
  if (!task) {
    throw new Error(`Execution task ${taskId} not found`);
  }

  const shouldRehomeOutput = !task.output_path || task.output_path === task.result_path;
  const relativePath = shouldRehomeOutput
    ? taskOutputRelativePath(db, task)
    : task.output_path ?? taskOutputRelativePath(db, task);
  const absolutePath = resolvePath(projectRoot, relativePath);

  mkdirSync(dirname(absolutePath), { recursive: true });
  if (!existsSync(absolutePath)) {
    writeFileSync(absolutePath, "", "utf-8");
  }

  if (task.output_path !== relativePath) {
    db.executionTasks.update(task.id, {
      output_path: relativePath,
    });
  }

  return absolutePath;
}

export function appendExecutionTaskOutput(
  db: CnogDB,
  taskId: string,
  content: string,
  projectRoot: string,
): void {
  if (!content) return;
  const outputPath = ensureExecutionTaskOutput(db, taskId, projectRoot);
  appendFileSync(outputPath, content, "utf-8");
}

export function setExecutionTaskResultPath(
  db: CnogDB,
  taskId: string,
  resultPath: string | null,
): void {
  db.executionTasks.update(taskId, {
    result_path: resultPath,
  });
}

export function resetExecutionTaskNotification(
  db: CnogDB,
  taskId: string,
  projectRoot: string,
): void {
  const outputPath = ensureExecutionTaskOutput(db, taskId, projectRoot);
  truncateSync(outputPath, 0);
  db.executionTasks.update(taskId, {
    process_id: null,
    exit_code: null,
    output_size: 0,
    last_output_at: null,
    notified: 0,
    notified_at: null,
    output_offset: 0,
  });
}

export function killExecutionTaskProcess(task: ExecutionTaskRow): void {
  if (!task.process_id) return;
  try {
    process.kill(task.process_id, "SIGKILL");
  } catch {
    // Already dead or inaccessible; either way the task should stop owning it.
  }
}

export function selectExecutionTaskAttempt(db: CnogDB, task: ExecutionTaskRow): SelectedTaskAttempt {
  const sessions = db.sessions
    .list({ run_id: task.run_id })
    .filter((session) => session.execution_task_id === task.id)
    .sort((a, b) => {
      if (b.attempt !== a.attempt) return b.attempt - a.attempt;
      return b.started_at.localeCompare(a.started_at);
    });

  if (task.active_session_id) {
    const active = sessions.find((session) => session.id === task.active_session_id)
      ?? db.sessions.getById(task.active_session_id);
    if (active) {
      return {
        session: active,
        reason: "active",
        attemptCount: sessions.length,
      };
    }
  }

  return {
    session: sessions[0] ?? null,
    reason: sessions[0] ? "latest" : "none",
    attemptCount: sessions.length,
  };
}

function formatTaskOutputTail(outputPath: string, content: string): string {
  const header = `[Truncated. Full output: ${outputPath}]\n\n`;
  const remaining = Math.max(0, MAX_NOTIFICATION_OUTPUT_CHARS - header.length);
  return `${header}${content.slice(-remaining)}`;
}

function readTaskOutputDelta(task: ExecutionTaskRow, projectRoot: string): {
  outputPath: string | null;
  output: string | null;
} {
  const outputPath = task.output_path ?? null;
  if (!outputPath) {
    return { outputPath: null, output: null };
  }

  const absolutePath = resolvePath(projectRoot, outputPath);
  if (!existsSync(absolutePath)) {
    return { outputPath, output: null };
  }

  const size = statSync(absolutePath).size;
  const offset = task.output_offset > size ? 0 : task.output_offset;
  const deltaBytes = size - offset;

  if (deltaBytes <= 0) {
    return { outputPath, output: null };
  }

  const header = `[Truncated. Full output: ${outputPath}]\n\n`;
  const truncatedBudget = Math.max(0, MAX_NOTIFICATION_OUTPUT_CHARS - Buffer.byteLength(header, "utf-8"));
  const shouldTruncate = deltaBytes > truncatedBudget;
  const readLength = shouldTruncate ? truncatedBudget : deltaBytes;
  const start = shouldTruncate ? size - readLength : offset;
  const fd = openSync(absolutePath, "r");

  try {
    const buffer = Buffer.alloc(readLength);
    const bytesRead = readSync(fd, buffer, 0, readLength, start);
    const content = buffer.toString("utf-8", 0, bytesRead);
    return {
      outputPath,
      output: shouldTruncate ? formatTaskOutputTail(outputPath, content) : content,
    };
  } finally {
    closeSync(fd);
  }
}

export function collectPendingTaskNotifications(
  db: CnogDB,
  projectRoot: string,
  runId?: string,
): ExecutionTaskNotification[] {
  return db.executionTasks.pendingNotifications(runId).flatMap((task) => {
    const run = db.runs.get(task.run_id);
    if (!run) return [];
    const { outputPath, output } = readTaskOutputDelta(task, projectRoot);

    return [{
      task,
      run,
      outputPath,
      resultPath: task.result_path,
      output,
    }];
  });
}

export function markExecutionTaskNotified(
  db: CnogDB,
  taskId: string,
  projectRoot: string,
): void {
  const task = db.executionTasks.get(taskId);
  if (!task) return;

  let size = task.output_offset;
  if (task.output_path) {
    const absolutePath = resolvePath(projectRoot, task.output_path);
    if (existsSync(absolutePath)) {
      size = statSync(absolutePath).size;
    }
  }

  db.executionTasks.update(task.id, {
    output_offset: size,
  });
  db.executionTasks.markNotified(task.id);
}

export function supersedeExecutionTask(
  db: CnogDB,
  taskId: string,
  reason: string,
  projectRoot: string,
): ExecutionTaskRow | null {
  const task = db.executionTasks.get(taskId);
  if (!task) return null;

  if (task.active_session_id) {
    const session = db.sessions.getById(task.active_session_id);
    if (session?.tmux_session) {
      tmux.killSession(session.tmux_session);
    }
    if (session && session.state !== "completed" && session.state !== "failed") {
      db.sessions.updateState(session.name, "failed", `task superseded: ${reason}`);
    }
  }

  if (task.executor === "shell") {
    killExecutionTaskProcess(task);
    if (task.kind === "verify" && task.review_scope_id && task.parent_task_id) {
      const run = taskRun(db, task);
      cleanupReviewScopeVerifierWorktree(run.feature, task.review_scope_id, projectRoot);
    }
  }

  resetExecutionTaskNotification(db, task.id, projectRoot);
  appendExecutionTaskOutput(db, task.id, `[superseded] ${reason}\n`, projectRoot);
  db.executionTasks.update(task.id, {
    status: "superseded",
    active_session_id: null,
    process_id: null,
    summary: `Superseded: ${reason}`,
    last_error: null,
  });
  return db.executionTasks.get(task.id) ?? task;
}

export function supersedeExecutionTaskDescendants(
  db: CnogDB,
  parentTaskId: string,
  reason: string,
  projectRoot: string,
): ExecutionTaskRow[] {
  const superseded: ExecutionTaskRow[] = [];
  const stack = [...db.executionTasks.childrenOf(parentTaskId)];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    stack.push(...db.executionTasks.childrenOf(task.id));
    const updated = supersedeExecutionTask(db, task.id, reason, projectRoot);
    superseded.push(updated ?? task);
  }

  return superseded;
}
