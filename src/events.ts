/**
 * Structured event logging.
 *
 * Wraps CnogDB.logEvent with convenience methods for common event types.
 * Sources: orchestrator, agents, merge, mail, watchdog, dispatch, lifecycle.
 */

import type { CnogDB } from "./db.js";
import type { EventLevel } from "./types.js";

export class EventEmitter {
  constructor(private readonly db: CnogDB) {}

  emit(opts: {
    source: string;
    eventType: string;
    message: string;
    level?: EventLevel;
    agentName?: string;
    feature?: string;
    data?: Record<string, unknown>;
  }): void {
    this.db.events.log({
      level: opts.level ?? "info",
      source: opts.source,
      event_type: opts.eventType,
      agent_name: opts.agentName ?? null,
      feature: opts.feature ?? null,
      message: opts.message,
      data: opts.data ? JSON.stringify(opts.data) : null,
    });
  }

  // -------------------------------------------------------------------------
  // Agent lifecycle
  // -------------------------------------------------------------------------

  agentSpawned(name: string, capability: string, feature: string, branch: string): void {
    this.emit({
      source: "agents",
      eventType: "agent_spawned",
      message: `Spawned ${capability} agent ${name} on ${branch}`,
      agentName: name,
      feature,
      data: { capability, branch },
    });
  }

  agentStopped(name: string, reason: string): void {
    this.emit({
      source: "agents",
      eventType: "agent_stopped",
      message: `Stopped agent ${name}: ${reason}`,
      agentName: name,
      data: { reason },
    });
  }

  agentFailed(name: string, error: string): void {
    this.emit({
      source: "agents",
      eventType: "agent_failed",
      message: `Agent ${name} failed: ${error}`,
      level: "error",
      agentName: name,
      data: { error },
    });
  }

  agentNudged(name: string): void {
    this.emit({
      source: "watchdog",
      eventType: "agent_nudged",
      message: `Nudged stale agent ${name}`,
      level: "warn",
      agentName: name,
    });
  }

  // -------------------------------------------------------------------------
  // Merge events
  // -------------------------------------------------------------------------

  mergeEnqueued(branch: string, feature: string, agentName: string): void {
    this.emit({
      source: "merge",
      eventType: "merge_enqueued",
      message: `Enqueued ${branch} for merge`,
      feature,
      agentName,
      data: { branch },
    });
  }

  mergeCompleted(branch: string, tier: string): void {
    this.emit({
      source: "merge",
      eventType: "merge_completed",
      message: `Merged ${branch} (tier: ${tier})`,
      data: { branch, tier },
    });
  }

  mergeConflict(branch: string, conflicts: string[]): void {
    this.emit({
      source: "merge",
      eventType: "merge_conflict",
      message: `Merge conflict on ${branch}: ${conflicts.join(", ")}`,
      level: "warn",
      data: { branch, conflicts },
    });
  }

  // -------------------------------------------------------------------------
  // Mail events
  // -------------------------------------------------------------------------

  mailReceived(to: string, from: string, type: string): void {
    this.emit({
      source: "mail",
      eventType: "mail_received",
      message: `Mail from ${from} to ${to} (${type})`,
      agentName: to,
      data: { from, type },
    });
  }

  // -------------------------------------------------------------------------
  // Orchestrator events
  // -------------------------------------------------------------------------

  orchestratorStarted(): void {
    this.emit({
      source: "orchestrator",
      eventType: "orchestrator_started",
      message: "Orchestrator started",
    });
  }

  orchestratorStopped(): void {
    this.emit({
      source: "orchestrator",
      eventType: "orchestrator_stopped",
      message: "Orchestrator stopped",
    });
  }

  escalation(agentName: string, subject: string, body: string): void {
    this.emit({
      source: "orchestrator",
      eventType: "escalation",
      message: `Escalation from ${agentName}: ${subject}`,
      level: "warn",
      agentName,
      data: { subject, body },
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch events
  // -------------------------------------------------------------------------

  taskDispatched(agentName: string, task: string, feature: string, issueId?: string): void {
    this.emit({
      source: "dispatch",
      eventType: "task_dispatched",
      message: `Dispatched ${agentName} for task '${task}'`,
      agentName,
      feature,
      data: { task, issueId },
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle events
  // -------------------------------------------------------------------------

  phaseAdvanced(feature: string, from: string, to: string): void {
    this.emit({
      source: "lifecycle",
      eventType: "phase_advanced",
      message: `Feature ${feature}: ${from} -> ${to}`,
      feature,
      data: { from, to },
    });
  }

  // -------------------------------------------------------------------------
  // Run events
  // -------------------------------------------------------------------------

  runCreated(runId: string, feature: string): void {
    this.emit({
      source: "lifecycle",
      eventType: "run_created",
      message: `Run ${runId} created for ${feature}`,
      feature,
      data: { runId },
    });
  }

  scopeCreated(scopeId: string, runId: string, feature: string): void {
    this.emit({
      source: "lifecycle",
      eventType: "scope_created",
      message: `Review scope ${scopeId} created for run ${runId}`,
      feature,
      data: { scopeId, runId },
    });
  }

  scopeEvaluated(scopeId: string, verdict: string, feature: string): void {
    this.emit({
      source: "lifecycle",
      eventType: "scope_evaluated",
      message: `Scope ${scopeId}: ${verdict}`,
      feature,
      data: { scopeId, verdict },
    });
  }
}
