/**
 * Inter-agent messaging — the coordination plane.
 *
 * Agents communicate exclusively through typed, prioritized messages
 * stored in SQLite. Supports threading and standard protocol methods.
 */

import type { CnogDB } from "./db.js";
import {
  WorkerNotificationPayloadSchema,
} from "./types.js";
import type {
  MessageRow,
  MessageType,
  Priority,
  WorkerNotificationPayload,
} from "./types.js";

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export interface Message {
  id: number;
  fromAgent: string;
  toAgent: string;
  subject: string;
  body: string | null;
  type: MessageType;
  priority: Priority;
  threadId: string | null;
  payload: Record<string, unknown> | null;
  read: boolean;
  createdAt: string;
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    subject: row.subject,
    body: row.body,
    type: row.type as MessageType,
    priority: row.priority as Priority,
    threadId: row.thread_id,
    payload: row.payload ? safeJsonParse(row.payload) : null,
    read: row.read === 1,
    createdAt: row.created_at,
  };
}

function validatePayload(type: MessageType, payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (type === "worker_notification") {
    return WorkerNotificationPayloadSchema.parse(payload);
  }
  return payload;
}

export class MailClient {
  constructor(private readonly db: CnogDB) {}

  /**
   * Send a typed message between agents.
   */
  send(opts: {
    fromAgent: string;
    toAgent: string;
    subject: string;
    body?: string;
    type?: MessageType;
    priority?: Priority;
    threadId?: string;
    payload?: Record<string, unknown>;
    runId?: string;
  }): number {
    const payload = validatePayload(opts.type ?? "status", opts.payload);
    return this.db.messages.send({
      from_agent: opts.fromAgent,
      to_agent: opts.toAgent,
      subject: opts.subject,
      body: opts.body ?? null,
      type: opts.type ?? "status",
      priority: opts.priority ?? "normal",
      thread_id: opts.threadId ?? null,
      payload: payload ? JSON.stringify(payload) : null,
      run_id: opts.runId ?? null,
    });
  }

  /**
   * Get unread messages for an agent.
   */
  check(agent: string): Message[] {
    return this.db.messages.checkMail(agent).map(rowToMessage);
  }

  /**
   * List message history for an agent.
   */
  list(agent: string, limit: number = 50): Message[] {
    return this.db.messages.list(agent, limit).map(rowToMessage);
  }

  /**
   * Mark a single message as read.
   */
  read(msgId: number): void {
    this.db.messages.markRead(msgId);
  }

  /**
   * Mark all messages for an agent as read.
   */
  readAll(agent: string): void {
    this.db.messages.markAllRead(agent);
  }

  /**
   * Reply to a message, preserving the thread.
   */
  reply(original: Message, opts: {
    fromAgent: string;
    body: string;
    type?: MessageType;
    priority?: Priority;
    payload?: Record<string, unknown>;
  }): number {
    const threadId = original.threadId ?? String(original.id);
    return this.send({
      fromAgent: opts.fromAgent,
      toAgent: original.fromAgent,
      subject: `Re: ${original.subject}`,
      body: opts.body,
      type: opts.type ?? "status",
      priority: opts.priority ?? "normal",
      threadId,
      payload: opts.payload,
    });
  }

  notifyWorkerNotification(agentName: string, payload: WorkerNotificationPayload): number {
    return this.send({
      fromAgent: agentName,
      toAgent: "orchestrator",
      subject: `${payload.data.kind}: ${payload.summary}`,
      type: "worker_notification",
      priority: "high",
      payload,
      runId: payload.run.id,
    });
  }
}
