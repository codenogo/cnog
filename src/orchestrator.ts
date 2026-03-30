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
  extractEvaluationVerdict,
  isContractReviewMessage,
} from "./review.js";

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

    // 5. Build status snapshot
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
        case "worker_done":
          this.onWorkerDone(msg);
          break;
        case "merge_ready":
          this.onMergeReady(msg);
          break;
        case "escalation":
          this.onEscalation(msg);
          break;
        case "error":
          this.onError(msg);
          break;
        case "result":
          this.onResult(msg);
          break;
        default:
          // status messages logged but not acted on
          break;
      }
    }
  }

  /**
   * Agent reports task completion -> enqueue merge, close issue.
   */
  private onWorkerDone(msg: Message): void {
    this.services.execution?.handleWorkerDone(msg);
  }

  /**
   * Explicit merge readiness signal -> enqueue.
   */
  private onMergeReady(msg: Message): void {
    const session = this.db.sessions.get(msg.fromAgent);
    const payload = msg.payload ?? {};
    const feature = (payload.feature as string | undefined) ?? session?.feature ?? undefined;
    const branch = (payload.branch as string | undefined) ?? session?.branch ?? undefined;
    const headSha = (payload.head_sha as string | undefined) ?? "unknown";

    if (feature && branch && session) {
      this.mergeQueue.enqueue({
        feature,
        branch,
        agentName: msg.fromAgent,
        runId: session.run_id,
        sessionId: session.id,
        taskId: session.task_id ?? undefined,
        headSha,
      });
    }
  }

  /**
   * Agent is blocked -> log escalation for human.
   */
  private onEscalation(msg: Message): void {
    this.events.escalation(msg.fromAgent, msg.subject, msg.body ?? "");
  }

  /**
   * Agent error -> mark failed.
   */
  private onError(msg: Message): void {
    this.db.sessions.updateState(msg.fromAgent, "failed", msg.body ?? msg.subject);
    this.events.agentFailed(msg.fromAgent, msg.body ?? msg.subject);
  }

  /**
   * Task result (e.g., review verdict) -> process grading + advance lifecycle.
   */
  private onResult(msg: Message): void {
    const session = this.db.sessions.get(msg.fromAgent);
    if (!session?.feature) return;
    if (session.capability === "evaluator") {
      this.db.sessions.updateState(msg.fromAgent, "completed");
    }

    if (session.capability === "evaluator" && isContractReviewMessage(msg)) {
      const processed = applyContractReviewResult({
        runId: session.run_id,
        sessionId: session.id,
        sessionName: msg.fromAgent,
        feature: session.feature,
        message: msg,
        db: this.db,
        events: this.events,
        projectRoot: this.config.projectRoot,
      });
      if (processed > 0) {
        this.services.execution?.continueRun(session.run_id);
      }
      return;
    }

    const verdict = applyEvaluationResult({
      runId: session.run_id,
      sessionId: session.id,
      sessionName: msg.fromAgent,
      feature: session.feature,
      message: msg,
      db: this.db,
      events: this.events,
      lifecycle: this.lifecycle,
      projectRoot: this.config.projectRoot,
    });

    if (verdict && msg.payload?.scores && Array.isArray(msg.payload.scores)) {
      const extractedVerdict = extractEvaluationVerdict(msg) ?? verdict;
      this.events.emit({
        source: "orchestrator",
        eventType: "grading_completed",
        message: `Grading for ${msg.fromAgent}: ${extractedVerdict}`,
        agentName: msg.fromAgent,
        feature: session.feature,
        data: { verdict: extractedVerdict },
      });
    }
    if (verdict) {
      this.services.execution?.continueRun(session.run_id);
    }
  }
}
