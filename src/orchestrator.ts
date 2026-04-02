/**
 * Main dispatch loop — the persistent orchestrator process.
 *
 * Runs outside Claude as a background process (cnog start).
 * Each tick: handle mail -> process merges -> run watchdog -> report status.
 */

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { MailClient, Message } from "./mail.js";
import type { MergeQueue } from "./merge.js";
import type { Watchdog } from "./watchdog.js";
import type { Lifecycle } from "./lifecycle.js";
import type { ExecutionEngine } from "./execution.js";
import {
  applyContractReviewResult,
  applyEvaluationResult,
} from "./review.js";
import {
  collectPendingTaskNotifications,
  markExecutionTaskNotified,
} from "./task-runtime.js";
import {
  type Capability,
  type ExecutionTaskKind,
  type ExecutionTaskRow,
  type WorkerNotificationPayload,
  WorkerNotificationPayloadSchema,
} from "./types.js";

const TICK_INTERVAL_MS = 10_000; // 10 seconds
const MAX_WIP = 4;

export interface OrchestratorConfig {
  dbPath: string;
  projectRoot: string;
  agentsDir: string;
  canonicalBranch: string;
  tickInterval: number;
  maxWip: number;
  staleThreshold: number;
  zombieThreshold: number;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  dbPath: ".cnog/cnog.db",
  projectRoot: ".",
  agentsDir: "agents",
  canonicalBranch: "main",
  tickInterval: TICK_INTERVAL_MS,
  maxWip: MAX_WIP,
  staleThreshold: 5 * 60 * 1000,
  zombieThreshold: 15 * 60 * 1000,
};

export interface LoopStatus {
  activeAgents: number;
  pendingMerges: number;
  unreadMail: number;
  tick: number;
}

export interface OrchestratorServices {
  execution?: ExecutionEngine;
}

export class Orchestrator {
  private running = false;
  private tickCount = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly mail: MailClient,
    private readonly mergeQueue: MergeQueue,
    private readonly watchdog: Watchdog,
    private readonly lifecycle: Lifecycle,
    private readonly config: OrchestratorConfig = DEFAULT_CONFIG,
    private readonly services: OrchestratorServices = {},
  ) {}

  /**
   * Start the orchestrator loop.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.events.orchestratorStarted();

    // Recover from any prior crash — re-assess all non-terminal runs
    this.recover();

    // Handle graceful shutdown
    const shutdown = () => this.stop();
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Run first tick immediately, then schedule
    this.tick();
    this.timer = setInterval(() => {
      if (this.running) this.tick();
    }, this.config.tickInterval);
  }

  /**
   * Stop the orchestrator loop.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.events.orchestratorStopped();
  }

  /**
   * Recover from a crash or restart.
   * Re-processes unhandled mail and checks for orphaned/zombie sessions.
   */
  private recover(): void {
    // Re-process any unread orchestrator mail from before the crash
    this.handleMail();
    this.services.execution?.reconcileRuns?.();

    // Check for sessions that are "working" in DB but have no live tmux
    const active = this.db.sessions.active();
    for (const session of active) {
      if (session.state === "working" || session.state === "booting") {
        // Watchdog will handle dead/stale detection on next tick
        // Just log that we found in-flight sessions
        this.events.emit({
          source: "orchestrator",
          eventType: "recovery_found_session",
          message: `Recovery: found in-flight session ${session.name} (${session.state})`,
          agentName: session.name,
          feature: session.feature ?? undefined,
        });
      }
    }

    this.events.emit({
      source: "orchestrator",
      eventType: "recovery_complete",
      message: `Recovery complete: ${active.length} active session(s) found`,
    });
  }

  /**
   * Run integrity checks.
   * Returns any issues found.
   */
  integrityCheck(): string[] {
    const issues: string[] = [];

    // Every active session must have a run_id that exists
    for (const session of this.db.sessions.active()) {
      if (!session.run_id) {
        issues.push(`Session ${session.name} has no run_id`);
      } else {
        const run = this.db.runs.get(session.run_id);
        if (!run) {
          issues.push(`Session ${session.name} references missing run ${session.run_id}`);
        }
      }
    }

    // No runs stuck in non-terminal phases with zero active sessions
    const allRuns = this.db.db.prepare(
      "SELECT * FROM runs WHERE status NOT IN ('done','failed')",
    ).all() as Array<{ id: string; feature: string; status: string }>;

    for (const run of allRuns) {
      const sessions = this.db.sessions.list({ run_id: run.id });
      const activeSessions = sessions.filter(
        (s) => s.state !== "completed" && s.state !== "failed",
      );
      // Runs in plan/contract may not have sessions yet — that's ok
      if (activeSessions.length === 0 && (run.status === "build" || run.status === "evaluate")) {
        issues.push(`Run ${run.id} (${run.feature}) is in ${run.status} with no active sessions`);
      }
    }

    return issues;
  }

  /**
   * Run a single orchestrator cycle.
   */
  tick(): LoopStatus {
    this.tickCount++;

    // 1. Handle incoming mail
    this.handleMail();

    // 2. Process merge queue
    this.mergeQueue.processAll();

    // 3. Reconcile any resumable build/contract runs
    this.services.execution?.reconcileRuns?.();

    // 4. Run watchdog health checks
    this.watchdog.tick();

    // 5. Emit terminal task notifications exactly once
    this.flushTaskNotifications();

    // 6. Build status snapshot
    const active = this.db.sessions.active();
    const pending = this.db.merges.pending();
    const unread = this.db.messages.checkMail("orchestrator");

    return {
      activeAgents: active.length,
      pendingMerges: pending.length,
      unreadMail: unread.length,
      tick: this.tickCount,
    };
  }

  /**
   * Process unread orchestrator mail.
   */
  private handleMail(): void {
    const messages = this.mail.check("orchestrator");

    for (const msg of messages) {
      this.mail.read(msg.id);

      switch (msg.type) {
        case "worker_notification":
          this.onWorkerNotification(msg);
          break;
        default:
          // status messages logged but not acted on
          break;
      }
    }
  }

  private flushTaskNotifications(): void {
    for (const notification of collectPendingTaskNotifications(this.db, this.config.projectRoot)) {
      const eventType = notification.task.status === "completed"
        ? "task_completed"
        : notification.task.status === "superseded"
          ? "task_superseded"
          : "task_failed";
      const level = notification.task.status === "failed" ? "warn" : "info";
      this.events.emit({
        source: "orchestrator",
        eventType,
        level,
        message: `${notification.task.logical_name} ${notification.task.status}`,
        feature: notification.run.feature,
        data: {
          runId: notification.run.id,
          taskId: notification.task.id,
          kind: notification.task.kind,
          capability: notification.task.capability,
          executor: notification.task.executor,
          summary: notification.task.summary,
          outputPath: notification.outputPath,
          resultPath: notification.resultPath,
          output: notification.output,
          lastError: notification.task.last_error,
        },
      });
      markExecutionTaskNotified(this.db, notification.task.id, this.config.projectRoot);
    }
  }

  private onWorkerNotification(msg: Message): void {
    const session = this.db.sessions.get(msg.fromAgent);
    const parsed = WorkerNotificationPayloadSchema.safeParse(msg.payload);
    if (!parsed.success) {
      this.failProtocolMessage(msg, parsed.error.message);
      return;
    }
    if (!session?.feature) {
      this.failProtocolMessage(msg, "Worker notification missing active session context");
      return;
    }

    const notification = parsed.data;

    try {
      this.validateWorkerNotification(session, msg, notification);
      this.authorizeWorkerNotification(session, notification);
    } catch (err) {
      this.failProtocolMessage(msg, err instanceof Error ? err.message : String(err));
      return;
    }

    if (notification.status === "progress") {
      this.events.emit({
        source: "orchestrator",
        eventType: "worker_progress",
        message: `${msg.fromAgent}: ${notification.summary}`,
        agentName: msg.fromAgent,
        feature: session.feature,
        data: notification,
      });
      return;
    }

    if (notification.status === "failed" || notification.status === "killed") {
      this.db.sessions.updateState(msg.fromAgent, "failed", notification.summary);
      this.services.execution?.handleSessionFailure(msg.fromAgent, notification.summary);
      this.events.agentFailed(msg.fromAgent, notification.summary);
      return;
    }

    try {
      switch (notification.data.kind) {
        case "builder_completion":
          if (notification.status !== "completed") {
            throw new Error(`Builder completion must use completed status, got ${notification.status}`);
          }
          this.services.execution?.handleWorkerDone(msg, notification.data, notification.summary);
          return;
        case "planner_completion":
        case "generic_completion":
          this.completeSessionFromNotification(session.name, notification.summary, notification.data.kind === "planner_completion" ? notification.data.planPath : undefined);
          this.events.emit({
            source: "orchestrator",
            eventType: "worker_completed",
            message: `${msg.fromAgent} completed ${notification.data.kind}`,
            agentName: msg.fromAgent,
            feature: session.feature,
            data: notification,
          });
          return;
        case "contract_review": {
          const processed = applyContractReviewResult({
            runId: session.run_id,
            sessionId: session.id,
            sessionName: msg.fromAgent,
            feature: session.feature,
            payload: notification.data,
            summary: notification.summary,
            db: this.db,
            events: this.events,
            projectRoot: this.config.projectRoot,
          });
          if (processed > 0) {
            this.services.execution?.handleEvaluationResult(msg.fromAgent, "contract_review_processed");
            this.services.execution?.continueRun(session.run_id);
          } else {
            this.completeSessionFromNotification(session.name, notification.summary);
          }
          this.db.sessions.updateState(msg.fromAgent, "completed");
          return;
        }
        case "implementation_review": {
          const verdict = applyEvaluationResult({
            runId: session.run_id,
            sessionId: session.id,
            sessionName: msg.fromAgent,
            feature: session.feature,
            payload: notification.data,
            summary: notification.summary,
            db: this.db,
            events: this.events,
            lifecycle: this.lifecycle,
            projectRoot: this.config.projectRoot,
          });

          if (verdict) {
            this.events.emit({
              source: "orchestrator",
              eventType: "grading_completed",
              message: `Grading for ${msg.fromAgent}: ${verdict}`,
              agentName: msg.fromAgent,
              feature: session.feature,
              data: { verdict, scopeId: notification.data.scopeId, scopeHash: notification.data.scopeHash },
            });
            this.services.execution?.handleEvaluationResult(msg.fromAgent, verdict);
            this.services.execution?.continueRun(session.run_id);
          } else {
            this.completeSessionFromNotification(session.name, notification.summary);
          }
          this.db.sessions.updateState(msg.fromAgent, "completed");
          return;
        }
        case "escalation":
          this.events.escalation(
            msg.fromAgent,
            `${notification.data.code}: ${notification.summary}`,
            notification.data.evidence.join("\n"),
          );
          this.db.sessions.updateState(msg.fromAgent, "stalled", notification.summary);
          if (session.execution_task_id) {
            this.db.executionTasks.update(session.execution_task_id, {
              status: "blocked",
              active_session_id: null,
              summary: `Blocked: ${notification.summary}`,
              last_error: notification.data.code,
            });
          }
          this.services.execution?.continueRun(session.run_id);
          return;
      }
    } catch (err) {
      this.failProtocolMessage(msg, err instanceof Error ? err.message : String(err));
    }
  }

  private validateWorkerNotification(session: NonNullable<ReturnType<CnogDB["sessions"]["get"]>>, msg: Message, payload: WorkerNotificationPayload): void {
    if (payload.actor.agentName !== msg.fromAgent) {
      throw new Error(`Notification actor mismatch: ${payload.actor.agentName} != ${msg.fromAgent}`);
    }
    if (payload.actor.sessionId !== session.id) {
      throw new Error(`Notification session mismatch for ${msg.fromAgent}`);
    }
    if (payload.actor.logicalName !== session.logical_name || payload.actor.attempt !== session.attempt) {
      throw new Error(`Notification attempt identity mismatch for ${msg.fromAgent}`);
    }
    if (payload.run.id !== session.run_id || payload.run.feature !== session.feature) {
      throw new Error(`Notification run mismatch for ${msg.fromAgent}`);
    }
    if (payload.actor.capability !== session.capability) {
      throw new Error(`Notification capability mismatch for ${msg.fromAgent}`);
    }
    if (payload.task.executionTaskId && payload.task.executionTaskId !== session.execution_task_id) {
      throw new Error(`Notification execution task mismatch for ${msg.fromAgent}`);
    }
    if (payload.task.issueId && session.task_id && payload.task.issueId !== session.task_id) {
      throw new Error(`Notification issue mismatch for ${msg.fromAgent}`);
    }
    const executionTask = session.execution_task_id
      ? this.db.executionTasks.get(session.execution_task_id)
      : null;
    if (session.execution_task_id && !executionTask) {
      throw new Error(`Notification references missing execution task ${session.execution_task_id}`);
    }
    if (executionTask) {
      if (payload.task.logicalName && payload.task.logicalName !== executionTask.logical_name) {
        throw new Error(`Notification logical task mismatch for ${msg.fromAgent}`);
      }
      if (payload.task.kind && payload.task.kind !== executionTask.kind) {
        throw new Error(`Notification task kind mismatch for ${msg.fromAgent}`);
      }
      if (payload.task.executor && payload.task.executor !== executionTask.executor) {
        throw new Error(`Notification task executor mismatch for ${msg.fromAgent}`);
      }
      if (payload.task.issueId && executionTask.issue_id && payload.task.issueId !== executionTask.issue_id) {
        throw new Error(`Notification execution task issue mismatch for ${msg.fromAgent}`);
      }
      if (payload.task.reviewScopeId && executionTask.review_scope_id && payload.task.reviewScopeId !== executionTask.review_scope_id) {
        throw new Error(`Notification review scope mismatch for ${msg.fromAgent}`);
      }
    }
    if (payload.task.reviewScopeId && this.db.runs.get(session.run_id)?.status === "evaluate") {
      const scope = this.db.reviewScopes.get(payload.task.reviewScopeId);
      if (!scope) {
        throw new Error(`Notification references unknown review scope ${payload.task.reviewScopeId}`);
      }
      if (payload.task.scopeHash && payload.task.scopeHash !== scope.scope_hash) {
        throw new Error(`Notification scope hash mismatch for ${payload.task.reviewScopeId}`);
      }
    }
  }

  private authorizeWorkerNotification(
    session: NonNullable<ReturnType<CnogDB["sessions"]["get"]>>,
    payload: WorkerNotificationPayload,
  ): void {
    const executionTask = session.execution_task_id
      ? this.db.executionTasks.get(session.execution_task_id) ?? null
      : null;

    if (payload.status === "blocked" && payload.data.kind !== "escalation") {
      throw new Error(`Only escalation notifications may report blocked status for ${session.name}`);
    }

    switch (payload.data.kind) {
      case "builder_completion":
        this.requireCapability(session.capability as Capability, "builder", "builder completion");
        this.requireTaskKind(executionTask, "build", "builder completion");
        return;
      case "planner_completion":
        this.requireCapability(session.capability as Capability, "planner", "planner completion");
        return;
      case "generic_completion":
        if (payload.data.role !== session.capability) {
          throw new Error(`Generic completion role mismatch for ${session.name}`);
        }
        return;
      case "contract_review":
        this.requireCapability(session.capability as Capability, "evaluator", "contract review");
        if (executionTask) {
          this.requireTaskKind(executionTask, "contract_review", "contract review");
        }
        return;
      case "implementation_review":
        this.requireCapability(session.capability as Capability, "evaluator", "implementation review");
        if (executionTask) {
          this.requireTaskKind(executionTask, "implementation_review", "implementation review");
        }
        return;
      case "escalation":
        if (payload.data.role !== session.capability) {
          throw new Error(`Escalation role mismatch for ${session.name}`);
        }
        return;
    }
  }

  private requireCapability(actual: Capability, expected: Capability, label: string): void {
    if (actual !== expected) {
      throw new Error(`${label} requires ${expected} capability, got ${actual}`);
    }
  }

  private requireTaskKind(
    task: ExecutionTaskRow | null,
    expected: ExecutionTaskKind,
    label: string,
  ): void {
    if (!task) {
      throw new Error(`${label} requires an execution task`);
    }
    if (task.kind !== expected) {
      throw new Error(`${label} requires ${expected} task, got ${task.kind}`);
    }
  }

  private completeSessionFromNotification(sessionName: string, summary: string, resultPath?: string): void {
    const session = this.db.sessions.get(sessionName);
    if (!session) return;

    this.db.sessions.updateState(sessionName, "completed");
    if (session.execution_task_id) {
      this.db.executionTasks.update(session.execution_task_id, {
        status: "completed",
        active_session_id: null,
        summary,
        result_path: resultPath ?? null,
        last_error: null,
      });
    }
  }

  private failProtocolMessage(msg: Message, reason: string): void {
    const session = this.db.sessions.get(msg.fromAgent);
    if (session && session.state !== "completed" && session.state !== "failed") {
      this.db.sessions.updateState(msg.fromAgent, "failed", `protocol violation: ${reason}`);
      this.services.execution?.handleSessionFailure(msg.fromAgent, `protocol violation: ${reason}`);
    }
    this.events.emit({
      source: "orchestrator",
      eventType: "protocol_violation",
      level: "error",
      message: `Protocol violation from ${msg.fromAgent}: ${reason}`,
      agentName: msg.fromAgent,
      feature: session?.feature ?? undefined,
      data: {
        messageType: msg.type,
        subject: msg.subject,
      },
    });
  }
}
