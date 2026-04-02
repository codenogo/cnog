import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type {
  ExecutionTaskRow,
  ImplementationReviewData,
  MergeQueueRow,
  ReviewScopeRow,
  RunPhase,
  RunRow,
} from "./types.js";
import { ContractManager, loadContractFromArtifact } from "./contracts.js";
import { runArchiveDir } from "./paths.js";
import { killExecutionTaskProcess } from "./task-runtime.js";
import { cleanupReviewScopeVerifierWorktree } from "./verify-worktree.js";
import * as tmux from "./tmux.js";
import * as worktree from "./worktree.js";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "superseded"]);

function isoNow(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export class RunController {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  resetRun(runId: string, reason: string, targetPhase: RunPhase): { run: RunRow; archivePath: string } {
    const run = this.db.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const merges = this.db.merges.listForRun(runId);
    const scopes = this.db.reviewScopes.listByRun(runId);
    const archiveDir = runArchiveDir(run.feature, run.id, this.projectRoot);
    mkdirSync(archiveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(archiveDir, `reset-${timestamp}.json`);
    const archivePayload = {
      archivedAt: new Date().toISOString(),
      reason,
      run,
      issues: this.db.issues.list({ run_id: runId }),
      sessions: this.db.sessions.list({ run_id: runId }),
      merges,
      scopes,
      reviewAttempts: scopes.flatMap((scope) => this.db.reviewAttempts.listByScope(scope.id)),
      artifacts: this.db.artifacts.listByRun(runId),
    };
    writeFileSync(archivePath, JSON.stringify(archivePayload, null, 2), "utf-8");

    for (const session of this.db.sessions.list({ run_id: runId })) {
      if (session.tmux_session) {
        tmux.killSession(session.tmux_session);
      }
      if (session.worktree_path) {
        worktree.remove(session.name, this.projectRoot, true);
      }
      if (session.feature && session.branch) {
        worktree.deleteBranch(session.feature, session.name, this.projectRoot, true);
      }
      if (session.state !== "completed" && session.state !== "failed") {
        this.db.sessions.updateState(session.name, "failed", `run reset: ${reason}`);
      }
    }

    const cleanedScopeVerifiers = new Set<string>();
    for (const task of this.db.executionTasks.list({ run_id: runId })) {
      if (task.executor === "shell") {
        killExecutionTaskProcess(task);
      }
      if (
        task.kind === "verify"
        && task.review_scope_id
        && task.parent_task_id
        && !cleanedScopeVerifiers.has(task.review_scope_id)
      ) {
        cleanupReviewScopeVerifierWorktree(run.feature, task.review_scope_id, this.projectRoot);
        cleanedScopeVerifiers.add(task.review_scope_id);
      }
      if (!TERMINAL_TASK_STATUSES.has(task.status)) {
        this.db.executionTasks.update(task.id, {
          status: "superseded",
          active_session_id: null,
          process_id: null,
          summary: `Superseded by run reset: ${reason}`,
          last_error: null,
          notified: 1,
          notified_at: isoNow(),
        });
      }
    }

    this.db.issues.resetRun(runId);
    this.db.merges.failNonMergedForRun(runId);
    this.db.reviewScopes.staleForRun(runId);
    this.db.runs.update(runId, {
      status: targetPhase,
      phase_reason: `reset: ${reason}`,
      review: null,
      ship: null,
      tasks: null,
    });

    return { run, archivePath };
  }

  reopenScopeForRework(opts: {
    runId: string;
    feature: string;
    scope: Pick<ReviewScopeRow, "id" | "merge_entries" | "contract_ids">;
    targetPhase: "build" | "contract";
    verdict: ImplementationReviewData["verdict"];
    actor: string;
    summary: string;
  }): void {
    const mergeEntryIds = JSON.parse(opts.scope.merge_entries) as number[];
    const mergeEntries = new Map(
      this.db.merges.listForRun(opts.runId).map((entry) => [entry.id, entry]),
    );
    const notifiedAt = isoNow();

    for (const mergeEntryId of mergeEntryIds) {
      const mergeEntry = mergeEntries.get(mergeEntryId);
      if (!mergeEntry) {
        continue;
      }

      if (mergeEntry.task_id) {
        this.reopenIssue(mergeEntry.task_id, {
          actor: opts.actor,
          eventType: opts.targetPhase === "contract"
            ? "evaluation_contract_rework"
            : "evaluation_build_rework",
          data: {
            scopeId: opts.scope.id,
            mergeEntryId,
            verdict: opts.verdict,
            summary: opts.summary,
          },
        });
      }

      if (mergeEntry.status !== "merged" && mergeEntry.status !== "failed") {
        this.db.merges.updateStatus(mergeEntry.id, "failed", "reimagine");
      }

      const mergeTask = this.db.executionTasks.getByLogicalName(
        opts.runId,
        `merge:${mergeEntry.id}`,
      );
      if (mergeTask && !TERMINAL_TASK_STATUSES.has(mergeTask.status)) {
        this.db.executionTasks.update(mergeTask.id, {
          status: "superseded",
          active_session_id: null,
          process_id: null,
          summary: `Superseded after ${opts.verdict} on scope ${opts.scope.id}`,
          last_error: null,
          notified: 1,
          notified_at: notifiedAt,
        });
      }
    }

    this.staleOtherScopes(opts.runId, opts.scope.id);

    if (opts.targetPhase !== "contract") {
      return;
    }

    const contractManager = new ContractManager(this.db, this.events, this.projectRoot);
    const contractArtifactIds = JSON.parse(opts.scope.contract_ids) as string[];
    for (const artifactId of contractArtifactIds) {
      const artifact = this.db.artifacts.get(artifactId);
      if (!artifact) {
        continue;
      }
      const contract = loadContractFromArtifact(artifact, this.projectRoot);
      if (!contract || contract.status === "failed" || contract.status === "rejected") {
        continue;
      }
      contractManager.fail(contract.id, opts.feature);
    }
  }

  handleMergeConflict(opts: {
    entry: MergeQueueRow;
    conflicts: string[];
    actor?: string;
  }): { targetPhase: "build" | "failed" } {
    const actor = opts.actor ?? "merge";
    const run = this.db.runs.get(opts.entry.run_id);
    if (!run) {
      throw new Error(`Run ${opts.entry.run_id} not found`);
    }

    if (opts.entry.task_id) {
      this.reopenIssue(opts.entry.task_id, {
        actor,
        eventType: "merge_conflict",
        data: {
          branch: opts.entry.branch,
          conflicts: opts.conflicts,
        },
      });
    }

    for (const scope of this.db.reviewScopes.listByRun(opts.entry.run_id)) {
      if (scope.scope_status === "approved" || scope.scope_status === "evaluating") {
        this.db.reviewScopes.updateStatus(scope.id, "stale");
      }
    }

    return { targetPhase: opts.entry.task_id ? "build" : "failed" };
  }

  private reopenIssue(
    issueId: string,
    opts: {
      actor: string;
      eventType: string;
      data: Record<string, unknown>;
    },
  ): void {
    const issue = this.db.issues.get(issueId);
    if (!issue) {
      return;
    }

    this.db.issues.update(issueId, {
      status: "open",
      assignee: null,
    });
    this.db.issues.logEvent({
      issue_id: issueId,
      event_type: opts.eventType,
      actor: opts.actor,
      data: JSON.stringify(opts.data),
    });
  }

  private staleOtherScopes(runId: string, preservedScopeId: string): void {
    for (const scope of this.db.reviewScopes.listByRun(runId)) {
      if (scope.id === preservedScopeId) {
        continue;
      }
      if (scope.scope_status === "approved" || scope.scope_status === "evaluating" || scope.scope_status === "pending") {
        this.db.reviewScopes.updateStatus(scope.id, "stale");
      }
    }
  }
}
