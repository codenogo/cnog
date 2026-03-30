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
  ) {}

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
    const observation: HealthObservation = {
      session,
      tmuxAlive: session.tmux_session
        ? this.probes.isSessionAlive(session.tmux_session)
        : false,
      pidAlive: session.pid ? this.probes.isPidAlive(session.pid) : false,
      elapsedMs: elapsedSince(
        session.last_heartbeat ?? session.started_at,
        this.probes.nowMs(),
      ),
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

    switch (decision.kind) {
      case "dead":
        this.handleFailure(session, decision.reason ?? "process died", "process died");
        break;
      case "zombie":
        if (session.tmux_session) {
          tmux.killSession(session.tmux_session);
        }
        this.handleFailure(
          session,
          decision.reason ?? "zombie threshold exceeded",
          "zombie threshold exceeded",
        );
        break;
      case "stale":
        this.db.sessions.updateState(session.name, "stalled");
        if (decision.shouldNudge) {
          const nudge = this.buildStallNudge(session);
          if (session.tmux_session) {
            tmux.sendKeys(session.tmux_session, nudge);
          }
          this.events.agentNudged(session.name);
        }
        break;
      case "recovered":
        this.db.sessions.updateState(session.name, "working");
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
      type: "error",
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
