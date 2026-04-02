import type { SessionRow, SessionState } from "./types.js";

export interface HealthThresholds {
  staleThresholdMs: number;
  zombieThresholdMs: number;
}

export interface HealthObservation {
  session: SessionRow;
  tmuxAlive: boolean;
  pidAlive: boolean;
  elapsedMs: number;
  transcriptGrew?: boolean;
  waitingForInput?: boolean;
}

export type HealthKind = "healthy" | "recovered" | "dead" | "stale" | "zombie";
export type HealthAction = "none" | "mark_working" | "mark_stalled" | "mark_failed" | "kill_tmux";

export interface HealthDecision {
  kind: HealthKind;
  action: HealthAction;
  nextState: SessionState;
  reason: string | null;
  shouldNotify: boolean;
  shouldNudge: boolean;
}

export interface SessionHealth {
  observation: HealthObservation;
  decision: HealthDecision;
}

export function elapsedSince(isoTimestamp: string | null, nowMs: number = Date.now()): number {
  if (!isoTimestamp) return Infinity;
  return nowMs - new Date(isoTimestamp).getTime();
}

export function evaluateHealth(
  observation: HealthObservation,
  thresholds: HealthThresholds,
): HealthDecision {
  const session = observation.session;

  if (session.state === "booting") {
    return {
      kind: "healthy",
      action: "none",
      nextState: "booting",
      reason: null,
      shouldNotify: false,
      shouldNudge: false,
    };
  }

  if (!observation.tmuxAlive && !observation.pidAlive) {
    return {
      kind: "dead",
      action: "mark_failed",
      nextState: "failed",
      reason: "process died",
      shouldNotify: true,
      shouldNudge: false,
    };
  }

  if (observation.elapsedMs > thresholds.zombieThresholdMs) {
    if (observation.waitingForInput) {
      return {
        kind: "stale",
        action: "mark_stalled",
        nextState: "stalled",
        reason: "waiting for interactive input",
        shouldNotify: false,
        shouldNudge: session.state !== "stalled",
      };
    }
    return {
      kind: "zombie",
      action: "kill_tmux",
      nextState: "failed",
      reason: `zombie: no heartbeat for ${Math.round(thresholds.zombieThresholdMs / 60000)}min`,
      shouldNotify: true,
      shouldNudge: false,
    };
  }

  if (observation.elapsedMs > thresholds.staleThresholdMs) {
    return {
      kind: "stale",
      action: "mark_stalled",
      nextState: "stalled",
      reason: observation.waitingForInput
        ? "waiting for interactive input"
        : `no heartbeat for ${Math.round(observation.elapsedMs / 60000)}min`,
      shouldNotify: false,
      shouldNudge: session.state !== "stalled",
    };
  }

  if (session.state === "stalled") {
    return {
      kind: "recovered",
      action: "mark_working",
      nextState: "working",
      reason: "heartbeat recovered",
      shouldNotify: false,
      shouldNudge: false,
    };
  }

  return {
    kind: "healthy",
    action: "none",
    nextState: session.state as SessionState,
    reason: null,
    shouldNotify: false,
    shouldNudge: false,
  };
}
