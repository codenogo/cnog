import chalk from "chalk";
import { spawnSync } from "node:child_process";

import {
  CapabilitySchema,
  ContractReviewDecisionPayloadSchema,
  EscalationCodeSchema,
  MessageTypeSchema,
  PrioritySchema,
  ReworkPhaseSchema,
  ReviewVerdictSchema,
  ScorePayloadSchema,
} from "../types.js";
import type {
  CnogDB,
} from "../db.js";
import type {
  Capability,
  MessageType,
  WorkerNotificationData,
  WorkerNotificationPayload,
  WorkerUsage,
} from "../types.js";
import { MailClient } from "../mail.js";
import { _git } from "../worktree.js";
import { withDb } from "./context.js";

export interface AgentMailContext {
  fromAgent: string | null;
  feature: string | null;
  branch: string | null;
}

interface ReportContext {
  session: ReturnType<CnogDB["sessions"]["get"]>;
  run: ReturnType<CnogDB["runs"]["get"]>;
  task: ReturnType<CnogDB["executionTasks"]["get"]> | undefined;
}

function parsePayload(rawPayload?: string): Record<string, unknown> | undefined {
  if (!rawPayload) return undefined;
  try {
    return JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid payload JSON. Pass a valid JSON object to --payload.");
  }
}

function parseJsonArray<T>(raw: string | undefined, label: string): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as T[];
  } catch {
    throw new Error(`Invalid ${label}. Pass a valid JSON array.`);
  }
}

function currentBranch(cwd: string = process.cwd()): string | null {
  const result = _git({ cwd }, "branch", "--show-current");
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
}

function gitValue(cwd: string, ...args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

function gitModifiedFiles(cwd: string): string[] {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

function splitCsv(value?: string): string[] {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isoMsDiff(startedAt: string, endedAt?: string | null): number | undefined {
  const start = Date.parse(startedAt.replace(" ", "T"));
  if (Number.isNaN(start)) return undefined;
  const end = endedAt ? Date.parse(endedAt.replace(" ", "T")) : Date.now();
  if (Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

function buildUsageSnapshot(db: CnogDB, session: NonNullable<ReportContext["session"]>): WorkerUsage | undefined {
  const durationMs = isoMsDiff(session.started_at, session.completed_at);
  const metrics = db.metrics.summaryForAgent(session.name, session.run_id);
  if (metrics.samples === 0 && durationMs === undefined) {
    return undefined;
  }

  const usage: WorkerUsage = {};
  if (metrics.samples > 0) {
    usage.inputTokens = metrics.total_input;
    usage.outputTokens = metrics.total_output;
    usage.totalTokens = metrics.total_input + metrics.total_output;
    usage.costUsd = metrics.total_cost;
  }
  if (durationMs !== undefined) {
    usage.durationMs = durationMs;
  }
  return usage;
}

function inferScopeHash(db: CnogDB, reviewScopeId?: string | null): string | undefined {
  if (!reviewScopeId) return undefined;
  return db.reviewScopes.get(reviewScopeId)?.scope_hash ?? undefined;
}

export function inferAgentMailContext(
  db: CnogDB,
  cwd: string = process.cwd(),
): AgentMailContext {
  const branch = currentBranch(cwd);
  const session = branch
    ? db.sessions.list().find((row) => row.branch === branch)
    : undefined;

  return {
    fromAgent: session?.name ?? null,
    feature: session?.feature ?? null,
    branch: branch ?? session?.branch ?? null,
  };
}

function resolveReportContext(db: CnogDB, opts?: { agent?: string; cwd?: string }): ReportContext {
  const cwd = opts?.cwd ?? process.cwd();
  const session = opts?.agent
    ? db.sessions.get(opts.agent)
    : (() => {
      const inferred = inferAgentMailContext(db, cwd);
      return inferred.fromAgent ? db.sessions.get(inferred.fromAgent) : undefined;
    })();

  if (!session) {
    throw new Error("Could not infer reporting session. Pass --agent when reporting outside the agent worktree.");
  }
  const run = db.runs.get(session.run_id);
  if (!run || !session.feature) {
    throw new Error(`Session ${session.name} is not attached to an active feature run.`);
  }
  const task = session.execution_task_id
    ? db.executionTasks.get(session.execution_task_id)
    : undefined;
  return { session, run, task };
}

function buildNotificationPayload(
  db: CnogDB,
  ctx: ReportContext,
  opts: {
    status: WorkerNotificationPayload["status"];
    summary: string;
    data: WorkerNotificationData;
    worktree?: {
      headSha?: string;
      filesModified?: string[];
    };
  },
): WorkerNotificationPayload {
  const { session, run, task } = ctx;
  if (!session) {
    throw new Error("Missing reporting session.");
  }

  const worktreePath = session.worktree_path ?? undefined;
  const filesModified = opts.worktree?.filesModified;
  const usage = buildUsageSnapshot(db, session);

  return {
    protocolVersion: 2,
    kind: "worker_notification",
    status: opts.status,
    summary: opts.summary,
    run: {
      id: run!.id,
      feature: run!.feature,
    },
    actor: {
      agentName: session.name,
      logicalName: session.logical_name,
      attempt: session.attempt,
      capability: CapabilitySchema.parse(session.capability),
      runtime: session.runtime,
      sessionId: session.id,
    },
    task: {
      executionTaskId: task?.id ?? undefined,
      logicalName: task?.logical_name ?? undefined,
      kind: task ? task.kind as WorkerNotificationPayload["task"]["kind"] : undefined,
      executor: task ? task.executor as WorkerNotificationPayload["task"]["executor"] : undefined,
      issueId: task?.issue_id ?? session.task_id ?? undefined,
      reviewScopeId: task?.review_scope_id ?? undefined,
      scopeHash: inferScopeHash(db, task?.review_scope_id) ?? undefined,
    },
    output: {
      taskLogPath: task?.output_path ?? undefined,
      resultPath: task?.result_path ?? undefined,
      transcriptPath: session.transcript_path ?? undefined,
    },
    worktree: worktreePath || session.branch || opts.worktree?.headSha || filesModified
      ? {
        path: worktreePath,
        branch: session.branch ?? undefined,
        headSha: opts.worktree?.headSha,
        filesModified: filesModified && filesModified.length > 0 ? filesModified : undefined,
      }
      : undefined,
    usage,
    data: opts.data,
  };
}

function sendWorkerNotification(
  db: CnogDB,
  payload: WorkerNotificationPayload,
): number {
  const mail = new MailClient(db);
  return mail.notifyWorkerNotification(payload.actor.agentName, payload);
}

export function mailSendCommand(to: string, subject: string, opts: {
  body: string;
  type: string;
  priority: string;
  from?: string;
  payload?: string;
}): void {
  const msgType = MessageTypeSchema.parse(opts.type);
  const msgPriority = PrioritySchema.parse(opts.priority);
  withDb((db) => {
    const inferred = inferAgentMailContext(db);
    const payload = parsePayload(opts.payload);
    const mail = new MailClient(db);
    const id = mail.send({
      fromAgent: opts.from ?? inferred.fromAgent ?? "cli",
      toAgent: to,
      subject,
      body: opts.body || undefined,
      type: msgType,
      priority: msgPriority,
      payload,
    });
    console.log(chalk.green(`Message sent (id: ${id})`));
  });
}

export function reportBuilderCompleteCommand(opts: {
  summary: string;
  agent?: string;
  headSha?: string;
  files?: string;
}): void {
  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const worktreeCwd = ctx.session?.worktree_path ?? process.cwd();
    const headSha = opts.headSha ?? gitValue(worktreeCwd, "rev-parse", "HEAD") ?? undefined;
    const filesModified = splitCsv(opts.files);
    const payload = buildNotificationPayload(db, ctx, {
      status: "completed",
      summary: opts.summary,
      data: {
        kind: "builder_completion",
        headSha,
        filesModified: filesModified.length > 0 ? filesModified : gitModifiedFiles(worktreeCwd),
      },
      worktree: {
        headSha,
        filesModified: filesModified.length > 0 ? filesModified : gitModifiedFiles(worktreeCwd),
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported builder completion (id: ${id})`));
  });
}

export function reportPlannerCompleteCommand(opts: {
  summary: string;
  planPath: string;
  taskCount: number;
  planHash?: string;
  agent?: string;
}): void {
  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const payload = buildNotificationPayload(db, ctx, {
      status: "completed",
      summary: opts.summary,
      data: {
        kind: "planner_completion",
        planPath: opts.planPath,
        taskCount: opts.taskCount,
        planHash: opts.planHash,
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported planner completion (id: ${id})`));
  });
}

export function reportGenericCompleteCommand(opts: {
  summary: string;
  role: string;
  agent?: string;
}): void {
  const role = CapabilitySchema.parse(opts.role);
  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const payload = buildNotificationPayload(db, ctx, {
      status: "completed",
      summary: opts.summary,
      data: {
        kind: "generic_completion",
        role,
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported generic completion (id: ${id})`));
  });
}

export function reportContractReviewCommand(opts: {
  summary: string;
  decisions: string;
  agent?: string;
}): void {
  const decisions = parseJsonArray<unknown>(opts.decisions, "contract decisions")
    .map((entry) => ContractReviewDecisionPayloadSchema.parse(entry));
  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const payload = buildNotificationPayload(db, ctx, {
      status: "completed",
      summary: opts.summary,
      data: {
        kind: "contract_review",
        contracts: decisions,
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported contract review (id: ${id})`));
  });
}

export function reportImplementationReviewCommand(opts: {
  summary: string;
  verdict: string;
  scores: string;
  reworkPhase?: string;
  scopeId?: string;
  scopeHash?: string;
  agent?: string;
}): void {
  const verdict = ReviewVerdictSchema.parse(opts.verdict);
  const scores = parseJsonArray<unknown>(opts.scores, "review scores")
    .map((entry) => ScorePayloadSchema.parse(entry));
  const reworkPhase = opts.reworkPhase ? ReworkPhaseSchema.parse(opts.reworkPhase) : undefined;

  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const taskScopeId = ctx.task?.review_scope_id ?? undefined;
    const scopeId = opts.scopeId ?? taskScopeId;
    const scopeHash = opts.scopeHash ?? inferScopeHash(db, scopeId);
    if (!scopeId || !scopeHash) {
      throw new Error("Could not resolve review scope identity for implementation review.");
    }

    const payload = buildNotificationPayload(db, ctx, {
      status: "completed",
      summary: opts.summary,
      data: {
        kind: "implementation_review",
        scopeId,
        scopeHash,
        verdict,
        reworkPhase,
        scores,
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported implementation review (id: ${id})`));
  });
}

export function reportBlockedCommand(opts: {
  summary: string;
  code: string;
  role: string;
  evidence?: string;
  requestedAction?: string;
  agent?: string;
}): void {
  const code = EscalationCodeSchema.parse(opts.code);
  const role = CapabilitySchema.parse(opts.role);
  const evidence = parseJsonArray<string>(opts.evidence, "evidence");

  withDb((db) => {
    const ctx = resolveReportContext(db, { agent: opts.agent });
    const payload = buildNotificationPayload(db, ctx, {
      status: "blocked",
      summary: opts.summary,
      data: {
        kind: "escalation",
        role,
        code,
        evidence,
        requestedAction: opts.requestedAction,
      },
    });
    const id = sendWorkerNotification(db, payload);
    console.log(chalk.green(`Reported blocked status (id: ${id})`));
  });
}

export function mailCheckCommand(agent: string): void {
  withDb((db) => {
    const mail = new MailClient(db);
    const msgs = mail.check(agent);
    if (msgs.length === 0) {
      console.log(chalk.gray("No unread mail."));
      return;
    }
    for (const m of msgs) {
      console.log(`  [${m.type}] ${m.fromAgent} -> ${m.toAgent}: ${m.subject}`);
      if (m.body) console.log(`    ${m.body}`);
    }
  });
}

export function mailListCommand(agent: string, limit: number): void {
  withDb((db) => {
    const mail = new MailClient(db);
    const msgs = mail.list(agent, limit);
    for (const m of msgs) {
      const readIcon = m.read ? chalk.gray("✓") : chalk.blue("●");
      console.log(`  ${readIcon} [${m.type}] ${m.fromAgent}: ${m.subject}`);
    }
  });
}
