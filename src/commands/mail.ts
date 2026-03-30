import chalk from "chalk";

import { MessageTypeSchema, PrioritySchema } from "../types.js";
import type { MessageType } from "../types.js";
import { MailClient } from "../mail.js";
import type { CnogDB } from "../db.js";
import { _git } from "../worktree.js";
import { withDb } from "./context.js";

export interface AgentMailContext {
  fromAgent: string | null;
  feature: string | null;
  branch: string | null;
}

function parsePayload(rawPayload?: string): Record<string, unknown> | undefined {
  if (!rawPayload) return undefined;
  try {
    return JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid payload JSON. Pass a valid JSON object to --payload.");
  }
}

function currentBranch(cwd: string = process.cwd()): string | null {
  const result = _git({ cwd }, "branch", "--show-current");
  if (result.status !== 0) return null;
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : null;
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

function buildPayload(
  type: MessageType,
  explicitPayload: Record<string, unknown> | undefined,
  context: AgentMailContext,
): Record<string, unknown> | undefined {
  const payload = { ...(explicitPayload ?? {}) };

  if ((type === "worker_done" || type === "merge_ready")) {
    if (!("feature" in payload) && context.feature) {
      payload.feature = context.feature;
    }
    if (!("branch" in payload) && context.branch) {
      payload.branch = context.branch;
    }
    if (type === "worker_done" && !("files_modified" in payload)) {
      payload.files_modified = [];
    }

    if (typeof payload.feature !== "string" || typeof payload.branch !== "string") {
      throw new Error(
        `${type} messages require feature and branch. Run from an agent worktree or pass them in --payload.`,
      );
    }
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
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
    const payload = buildPayload(msgType, parsePayload(opts.payload), inferred);
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
