/**
 * Issue-based work tracking — the memory engine.
 *
 * Breaks features into issues (epic/task/subtask/bug) with dependencies.
 * Plan tasks map to issues; agents claim and close them as they work.
 */

import { randomUUID } from "node:crypto";

import type { CnogDB } from "./db.js";
import type { IssueRow, IssueType, IssueStatus } from "./types.js";

function safeJsonParse(str: string): Record<string, unknown> | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  issueType: IssueType;
  status: IssueStatus;
  priority: number;
  assignee: string | null;
  feature: string | null;
  planNumber: string | null;
  phase: string | null;
  parentId: string | null;
  metadata: Record<string, unknown> | null;
  deps: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

function rowToIssue(row: IssueRow, deps: string[]): Issue {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    issueType: row.issue_type as IssueType,
    status: row.status as IssueStatus,
    priority: row.priority,
    assignee: row.assignee,
    feature: row.feature,
    planNumber: row.plan_number,
    phase: row.phase,
    parentId: row.parent_id,
    metadata: row.metadata ? safeJsonParse(row.metadata) : null,
    deps,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

export class MemoryEngine {
  constructor(private readonly db: CnogDB) {}

  /**
   * Create a new issue.
   */
  create(opts: {
    title: string;
    description?: string;
    issueType?: IssueType;
    priority?: number;
    feature?: string;
    runId?: string;
    planNumber?: string;
    phase?: string;
    parentId?: string;
    metadata?: Record<string, unknown>;
  }): Issue {
    const id = `cn-${randomUUID().slice(0, 8)}`;

    this.db.issues.create({
      id,
      title: opts.title,
      description: opts.description ?? null,
      issue_type: opts.issueType ?? "task",
      status: "open",
      priority: opts.priority ?? 1,
      assignee: null,
      feature: opts.feature ?? null,
      run_id: opts.runId ?? "",
      plan_number: opts.planNumber ?? null,
      phase: opts.phase ?? null,
      parent_id: opts.parentId ?? null,
      metadata: opts.metadata ? JSON.stringify(opts.metadata) : null,
    });

    this.db.issues.logEvent({
      issue_id: id,
      event_type: "created",
      actor: "system",
      data: JSON.stringify({ title: opts.title }),
    });

    return this.get(id)!;
  }

  /**
   * Get an issue by ID, including its dependencies.
   */
  get(id: string): Issue | undefined {
    const row = this.db.issues.get(id);
    if (!row) return undefined;
    const deps = this.db.issues.getDeps(id).map((d) => d.depends_on);
    return rowToIssue(row, deps);
  }

  /**
   * List issues with optional filters.
   */
  list(opts?: {
    feature?: string;
    status?: string;
    assignee?: string;
    issueType?: string;
    runId?: string;
  }): Issue[] {
    const rows = this.db.issues.list({
      feature: opts?.feature,
      status: opts?.status,
      assignee: opts?.assignee,
      issue_type: opts?.issueType,
      run_id: opts?.runId,
    });
    return rows.map((row) => {
      const deps = this.db.issues.getDeps(row.id).map((d) => d.depends_on);
      return rowToIssue(row, deps);
    });
  }

  listForRun(runId: string, opts?: {
    status?: string;
    assignee?: string;
    issueType?: string;
  }): Issue[] {
    return this.list({
      runId,
      status: opts?.status,
      assignee: opts?.assignee,
      issueType: opts?.issueType,
    });
  }

  /**
   * Get issues ready for work: open with all deps done/closed.
   */
  ready(feature?: string): Issue[] {
    const open = this.list({ feature, status: "open" });
    return open.filter((issue) => {
      if (issue.deps.length === 0) return true;
      return issue.deps.every((depId) => {
        const dep = this.get(depId);
        return dep && (dep.status === "done" || dep.status === "closed");
      });
    });
  }

  readyForRun(runId: string): Issue[] {
    const open = this.listForRun(runId, { status: "open" });
    return open.filter((issue) => {
      if (issue.deps.length === 0) return true;
      return issue.deps.every((depId) => {
        const dep = this.get(depId);
        return dep && (dep.status === "done" || dep.status === "closed");
      });
    });
  }

  /**
   * Claim an issue for an agent (mark as in_progress).
   */
  claim(issueId: string, assignee: string): void {
    this.db.issues.update(issueId, { status: "in_progress", assignee });
    this.db.issues.logEvent({
      issue_id: issueId,
      event_type: "claimed",
      actor: assignee,
      data: null,
    });
  }

  /**
   * Mark an issue as done.
   */
  done(issueId: string, actor?: string): void {
    this.db.issues.update(issueId, { status: "done" });
    this.db.issues.logEvent({
      issue_id: issueId,
      event_type: "done",
      actor: actor ?? "system",
      data: null,
    });
  }

  /**
   * Close an issue.
   */
  close(issueId: string, reason?: string): void {
    this.db.issues.close(issueId);
    this.db.issues.logEvent({
      issue_id: issueId,
      event_type: "closed",
      actor: "system",
      data: reason ? JSON.stringify({ reason }) : null,
    });
  }

  /**
   * Add a dependency: issueId is blocked by dependsOn.
   */
  addDep(issueId: string, dependsOn: string): void {
    this.db.issues.addDep(issueId, dependsOn);
  }

  /**
   * Get issue statistics for a feature.
   */
  stats(feature?: string): Record<string, number> {
    const issues = this.list({ feature });
    const counts: Record<string, number> = {
      open: 0,
      in_progress: 0,
      done: 0,
      closed: 0,
    };
    for (const issue of issues) {
      counts[issue.status] = (counts[issue.status] ?? 0) + 1;
    }
    return counts;
  }
}
