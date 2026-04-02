import type {
  ExecutionTaskControlState,
  ExecutionTaskNotificationDelivery,
  ExecutionTaskProgressState,
  ExecutionTaskRow,
  ExecutionTaskStatus,
  ExecutionTaskTerminalStatus,
  ExecutionTaskStallKind,
  SessionActivity,
  SessionActivityKind,
  SessionProgressRow,
} from "./types.js";
import {
  ExecutionTaskControlStateSchema,
  ExecutionTaskStatusSchema,
} from "./types.js";

const TERMINAL_STATUSES = new Set<ExecutionTaskTerminalStatus>([
  "completed",
  "failed",
  "superseded",
]);

function coerceExecutionTaskStatus(value: string | null | undefined): ExecutionTaskStatus {
  const parsed = ExecutionTaskStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "pending";
}

function isTerminalStatus(status: string): status is ExecutionTaskTerminalStatus {
  return TERMINAL_STATUSES.has(status as ExecutionTaskTerminalStatus);
}

export function createExecutionTaskControlState(
  status: string = "pending",
): ExecutionTaskControlState {
  const normalizedStatus = coerceExecutionTaskStatus(status);
  return {
    schemaVersion: 1,
    backgrounded: true,
    retained: false,
    pendingMessages: [],
    lifecycle: {
      currentStatus: normalizedStatus,
      transitionCount: 0,
      reopenedCount: 0,
      terminalCount: isTerminalStatus(normalizedStatus) ? 1 : 0,
    },
    notification: {
      sequence: 0,
      delivery: "idle",
      lastTerminalStatus: isTerminalStatus(normalizedStatus) ? normalizedStatus : null,
      lastEnqueuedAt: null,
      lastDeliveredAt: null,
      lastOutputOffset: 0,
    },
    progress: {
      toolUseCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      lastActivityAt: null,
      lastActivityKind: null,
      lastActivitySummary: null,
      recentActivities: [],
    },
    stall: {
      kind: normalizedStatus === "blocked" ? "blocked" : "healthy",
      reason: null,
      detectedAt: null,
      nudgeCount: 0,
    },
  };
}

export function parseExecutionTaskControlState(
  raw: string | null | undefined,
  status: string = "pending",
): ExecutionTaskControlState {
  if (!raw) {
    return createExecutionTaskControlState(status);
  }

  try {
    const parsed = ExecutionTaskControlStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      const next = parsed.data;
      next.lifecycle.currentStatus = coerceExecutionTaskStatus(
        next.lifecycle.currentStatus ?? status,
      );
      return next;
    }
  } catch {
    // Fall through to default state.
  }

  return createExecutionTaskControlState(status);
}

export function serializeExecutionTaskControlState(
  state: ExecutionTaskControlState,
): string {
  return JSON.stringify(state);
}

export function deriveExecutionTaskControlStateFromMutation(
  task: Pick<
    ExecutionTaskRow,
    "status" | "output_offset" | "notified" | "notified_at" | "control_state_json"
  >,
  fields: Partial<
    Pick<ExecutionTaskRow, "status" | "output_offset" | "notified" | "notified_at">
  >,
  nowIso: string,
): ExecutionTaskControlState {
  const currentStatus = coerceExecutionTaskStatus(task.status);
  const nextStatus = coerceExecutionTaskStatus(fields.status ?? task.status);
  const nextOutputOffset = fields.output_offset ?? task.output_offset ?? 0;
  const nextNotified = fields.notified ?? task.notified ?? 0;
  const nextNotifiedAt = fields.notified_at ?? task.notified_at ?? null;

  const state = parseExecutionTaskControlState(task.control_state_json, currentStatus);
  const statusChanged = nextStatus !== currentStatus;

  if (statusChanged) {
    state.lifecycle.transitionCount += 1;
    if (isTerminalStatus(currentStatus) && !isTerminalStatus(nextStatus)) {
      state.lifecycle.reopenedCount += 1;
    }
    if (isTerminalStatus(nextStatus)) {
      state.lifecycle.terminalCount += 1;
      state.notification.sequence += 1;
      state.notification.delivery = nextNotified === 1 ? "delivered" : "pending";
      state.notification.lastTerminalStatus = nextStatus;
      state.notification.lastEnqueuedAt = nowIso;
      state.notification.lastDeliveredAt = nextNotified === 1
        ? nextNotifiedAt ?? nowIso
        : null;
    } else {
      state.notification.delivery = "idle";
      if (nextStatus === "pending" || nextStatus === "running") {
        state.stall = {
          kind: "healthy",
          reason: null,
          detectedAt: null,
          nudgeCount: 0,
        };
      } else if (nextStatus === "blocked") {
        state.stall.kind = "blocked";
      }
    }
  }

  if (!statusChanged && fields.notified === 1) {
    state.notification.delivery = isTerminalStatus(nextStatus) ? "delivered" : state.notification.delivery;
    state.notification.lastDeliveredAt = nextNotifiedAt ?? nowIso;
  }

  if (!statusChanged && fields.notified === 0) {
    state.notification.delivery = isTerminalStatus(nextStatus) ? "pending" : "idle";
    if (fields.notified_at === null || fields.notified_at === undefined) {
      state.notification.lastDeliveredAt = null;
    }
  }

  state.notification.lastOutputOffset = Math.max(0, nextOutputOffset);
  state.lifecycle.currentStatus = nextStatus;
  return state;
}

export function applyExecutionTaskProgressSnapshot(
  current: ExecutionTaskControlState,
  progress: ExecutionTaskProgressState,
): ExecutionTaskControlState {
  return {
    ...current,
    progress: {
      ...progress,
      recentActivities: progress.recentActivities.slice(-8),
    },
  };
}

export function buildExecutionTaskProgressSnapshot(opts: {
  toolUseCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastActivityAt: string | null;
  lastActivityKind: SessionActivityKind | null;
  lastActivitySummary: string | null;
  recentActivities: SessionActivity[];
}): ExecutionTaskProgressState {
  return {
    toolUseCount: opts.toolUseCount,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
    costUsd: opts.costUsd,
    lastActivityAt: opts.lastActivityAt,
    lastActivityKind: opts.lastActivityKind,
    lastActivitySummary: opts.lastActivitySummary,
    recentActivities: opts.recentActivities.slice(-8),
  };
}

export function buildExecutionTaskProgressSnapshotFromSession(
  progress: SessionProgressRow,
): ExecutionTaskProgressState {
  let recentActivities: SessionActivity[] = [];
  try {
    recentActivities = JSON.parse(progress.recent_activities_json) as SessionActivity[];
  } catch {
    recentActivities = [];
  }

  return buildExecutionTaskProgressSnapshot({
    toolUseCount: progress.tool_use_count,
    inputTokens: progress.input_tokens,
    outputTokens: progress.output_tokens,
    costUsd: progress.cost_usd,
    lastActivityAt: progress.last_activity_at,
    lastActivityKind: progress.last_activity_kind,
    lastActivitySummary: progress.last_activity_summary,
    recentActivities,
  });
}

export function applyExecutionTaskStallState(
  current: ExecutionTaskControlState,
  opts: {
    kind: ExecutionTaskStallKind;
    reason: string | null;
    detectedAt: string | null;
    incrementNudgeCount?: boolean;
  },
): ExecutionTaskControlState {
  const nudgeCount = opts.incrementNudgeCount
    ? current.stall.nudgeCount + 1
    : current.stall.nudgeCount;
  return {
    ...current,
    stall: {
      kind: opts.kind,
      reason: opts.reason,
      detectedAt: opts.detectedAt,
      nudgeCount,
    },
  };
}

export function clearExecutionTaskStallState(
  current: ExecutionTaskControlState,
): ExecutionTaskControlState {
  if (current.stall.kind === "healthy" && current.stall.reason === null) {
    return current;
  }
  return {
    ...current,
    stall: {
      kind: "healthy",
      reason: null,
      detectedAt: null,
      nudgeCount: current.stall.nudgeCount,
    },
  };
}

export function queueExecutionTaskPendingMessage(
  current: ExecutionTaskControlState,
  message: string,
): ExecutionTaskControlState {
  return {
    ...current,
    pendingMessages: [...current.pendingMessages, message],
  };
}

export function drainExecutionTaskPendingMessages(
  current: ExecutionTaskControlState,
): { state: ExecutionTaskControlState; messages: string[] } {
  if (current.pendingMessages.length === 0) {
    return { state: current, messages: [] };
  }
  return {
    state: {
      ...current,
      pendingMessages: [],
    },
    messages: current.pendingMessages,
  };
}

export function executionTaskNotificationDeliveryForRow(
  task: Pick<ExecutionTaskRow, "status" | "notified">,
): ExecutionTaskNotificationDelivery {
  const status = coerceExecutionTaskStatus(task.status);
  if (!isTerminalStatus(status)) {
    return "idle";
  }
  return task.notified === 1 ? "delivered" : "pending";
}
