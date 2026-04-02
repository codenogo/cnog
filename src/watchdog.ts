/**
 * Process monitoring and stall detection.
 *
 * The watchdog is split into two layers:
 *   - pure health observation/evaluation in watchdog-policy.ts
 *   - side-effect execution here
 */

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { MailClient } from "./mail.js";
import type { SessionRow } from "./types.js";
import {
  applyExecutionTaskStallState,
  clearExecutionTaskStallState,
} from "./execution-task-state.js";
import { projectFileSize, readProjectFileTail } from "./file-tail.js";
import { looksInteractivePrompt } from "./prompt-detection.js";
import { getRuntime } from "./runtimes/index.js";
import * as tmux from "./tmux.js";
import {
  elapsedSince,
  evaluateHealth,
  type SessionHealth,
  type HealthObservation,
} from "./watchdog-policy.js";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const ZOMBIE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
export interface WatchdogProbes {
  isPidAlive(pid: number): boolean;
  isSessionAlive(sessionName: string): boolean;
  nowMs(): number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_PROBES: WatchdogProbes = {
  isPidAlive,
  isSessionAlive: (sessionName) => tmux.isSessionAlive(sessionName),
  nowMs: () => Date.now(),
};

export class Watchdog {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly mail: MailClient,
    private readonly staleThreshold: number = STALE_THRESHOLD_MS,
    private readonly zombieThreshold: number = ZOMBIE_THRESHOLD_MS,
    private readonly probes: WatchdogProbes = DEFAULT_PROBES,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  private maxIsoTimestamp(...timestamps: Array<string | null | undefined>): string | null {
    let best: string | null = null;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const timestamp of timestamps) {
      if (!timestamp) continue;
      const ms = Date.parse(timestamp.replace(" ", "T"));
      if (Number.isNaN(ms)) continue;
      if (ms > bestMs) {
        bestMs = ms;
        best = timestamp;
      }
    }
    return best;
  }

  private observeTranscript(session: SessionRow, nowIso: string): {
    grew: boolean;
    waitingForInput: boolean;
    transcriptSize: number;
  } {
    if (!session.transcript_path) {
      return { grew: false, waitingForInput: false, transcriptSize: 0 };
    }

    const progress = this.db.sessionProgress.get(session.id);
    const transcriptSize = projectFileSize(session.transcript_path, this.projectRoot);
    const previousSize = progress?.transcript_size ?? 0;
    const grew = transcriptSize > previousSize;
    const waitingForInput = !grew
      && transcriptSize > 0
      && (() => {
        const tail = readProjectFileTail(session.transcript_path, this.projectRoot, 1_024);
        return looksInteractivePrompt(tail);
      })();

    if (grew || !progress) {
      this.db.sessionProgress.ensureFromSession(session.id);
      this.db.sessionProgress.update(session.id, {
        run_id: session.run_id,
        execution_task_id: session.execution_task_id,
        transcript_path: session.transcript_path,
        transcript_size: transcriptSize,
        last_output_at: grew ? nowIso : progress?.last_output_at ?? null,
      });
      if (grew) {
        this.db.sessions.heartbeat(session.name);
      }
    }

    return { grew, waitingForInput, transcriptSize };
  }

  /**
   * Observe every active session and return the canonical health snapshot.
   */
  inspectActive(): SessionHealth[] {
    return this.db.sessions.active().map((session) => this.inspectSession(session));
  }

  /**
   * Run one health check cycle across all active agents.
   */
  tick(): void {
    for (const health of this.inspectActive()) {
      this.applyDecision(health);
    }
  }

  private inspectSession(session: SessionRow): SessionHealth {
    const nowIso = new Date(this.probes.nowMs()).toISOString();
    const transcript = this.observeTranscript(session, nowIso.replace("T", " ").slice(0, 19));
    const progress = this.db.sessionProgress.get(session.id);
    const effectiveSignal = this.maxIsoTimestamp(
      session.last_heartbeat,
      progress?.last_activity_at,
      progress?.last_output_at,
      transcript.grew ? nowIso : null,
      session.started_at,
    );
    const observation: HealthObservation = {
      session: transcript.grew
        ? { ...session, last_heartbeat: nowIso.replace("T", " ").slice(0, 19) }
        : session,
      tmuxAlive: session.tmux_session
        ? this.probes.isSessionAlive(session.tmux_session)
        : false,
      pidAlive: session.pid ? this.probes.isPidAlive(session.pid) : false,
      elapsedMs: elapsedSince(
        effectiveSignal ?? session.started_at,
        this.probes.nowMs(),
      ),
      transcriptGrew: transcript.grew,
      waitingForInput: transcript.waitingForInput,
    };

    return {
      observation,
      decision: evaluateHealth(observation, {
        staleThresholdMs: this.staleThreshold,
        zombieThresholdMs: this.zombieThreshold,
      }),
    };
  }

  private applyDecision(health: SessionHealth): void {
    const { session } = health.observation;
    const { decision } = health;
    const nowIso = new Date(this.probes.nowMs()).toISOString().replace("T", " ").slice(0, 19);
    const executionTask = session.execution_task_id
      ? this.db.executionTasks.get(session.execution_task_id)
      : null;

    // A task-blocked session is intentionally non-runnable; keep its stalled state
    // stable instead of reclassifying it as dead/zombie on later ticks.
    if (executionTask?.status === "blocked") {
      this.db.executionTasks.updateControlState(executionTask.id, (current) =>
        applyExecutionTaskStallState(current, {
          kind: "blocked",
          reason: executionTask.summary ?? executionTask.last_error ?? decision.reason ?? null,
          detectedAt: current.stall.detectedAt ?? nowIso,
        }),
      );
      return;
    }

    switch (decision.kind) {
      case "dead":
        if (executionTask) {
          this.db.executionTasks.updateControlState(executionTask.id, (current) =>
            applyExecutionTaskStallState(current, {
              kind: "stalled",
              reason: decision.reason ?? "process died",
              detectedAt: current.stall.detectedAt ?? nowIso,
            }),
          );
        }
        this.handleFailure(session, decision.reason ?? "process died", "process died");
        break;
      case "zombie":
        if (session.tmux_session) {
          tmux.killSession(session.tmux_session);
        }
        if (executionTask) {
          this.db.executionTasks.updateControlState(executionTask.id, (current) =>
            applyExecutionTaskStallState(current, {
              kind: "stalled",
              reason: decision.reason ?? "zombie threshold exceeded",
              detectedAt: current.stall.detectedAt ?? nowIso,
            }),
          );
        }
        this.handleFailure(
          session,
          decision.reason ?? "zombie threshold exceeded",
          "zombie threshold exceeded",
        );
        break;
      case "stale":
        this.db.sessions.updateState(session.name, "stalled", decision.reason ?? undefined);
        if (executionTask) {
          this.db.executionTasks.updateControlState(executionTask.id, (current) =>
            applyExecutionTaskStallState(current, {
              kind: decision.reason === "waiting for interactive input"
                ? "waiting_input"
                : "stalled",
              reason: decision.reason ?? null,
              detectedAt: current.stall.detectedAt ?? nowIso,
              incrementNudgeCount: decision.shouldNudge,
            }),
          );
        }
        if (decision.reason === "waiting for interactive input" && session.error !== decision.reason) {
          this.events.emit({
            source: "watchdog",
            eventType: "agent_waiting_input",
            message: `${session.name} appears to be waiting for interactive input`,
            agentName: session.name,
            feature: session.feature ?? undefined,
            data: { runtime: session.runtime },
          });
        }
        if (decision.shouldNudge) {
          const nudge = decision.reason === "waiting for interactive input"
            ? "Your last command appears to be waiting for interactive input. Resolve it, report blocked, or continue the task."
            : this.buildStallNudge(session);
          if (session.tmux_session) {
            tmux.sendKeys(session.tmux_session, nudge);
          }
          this.events.agentNudged(session.name);
        }
        break;
      case "recovered":
        this.db.sessions.updateState(session.name, "working");
        if (executionTask) {
          this.db.executionTasks.updateControlState(executionTask.id, (current) =>
            clearExecutionTaskStallState(current),
          );
        }
        this.events.emit({
          source: "watchdog",
          eventType: "agent_recovered",
          message: `Recovered stalled agent ${session.name}`,
          agentName: session.name,
          feature: session.feature ?? undefined,
          data: { runtime: session.runtime },
        });
        break;
      case "healthy":
        if (executionTask) {
          this.db.executionTasks.updateControlState(executionTask.id, (current) =>
            clearExecutionTaskStallState(current),
          );
        }
        break;
    }
  }

  private handleFailure(session: SessionRow, stateReason: string, notificationReason: string): void {
    this.db.sessions.updateState(session.name, "failed", stateReason);
    this.events.agentFailed(session.name, stateReason);

    const target = session.parent_agent ?? "orchestrator";
    this.mail.send({
      fromAgent: "watchdog",
      toAgent: target,
      subject: `${notificationReason}: ${session.name}`,
      type: "status",
      priority: "urgent",
      payload: {
        agent: session.name,
        feature: session.feature,
        reason: notificationReason,
      },
    });
  }

  private buildStallNudge(session: SessionRow): string {
    try {
      const runtime = getRuntime(session.runtime);
      return runtime.buildStallNudge?.(session.name)
        ?? "You appear stalled. Please send a heartbeat or report your status.";
    } catch {
      return "You appear stalled. Please send a heartbeat or report your status.";
    }
  }
}
