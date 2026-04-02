/**
 * FIFO merge queue with 4-tier conflict resolution.
 *
 * Tier 1: Clean merge (no conflicts)
 * Tier 2: Auto-resolve (keep incoming changes via -X theirs)
 * Tier 3: AI-resolve (marked for orchestrator to spawn resolver)
 * Tier 4: Re-imagine (abort, re-plan)
 *
 * Merge is gated by the run lifecycle and feeds back into run rework when
 * conflicts are detected.
 */

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { Lifecycle } from "./lifecycle.js";
import type { ArtifactRow, ExecutionTaskRow, MergeQueueRow } from "./types.js";
import { persistJsonArtifact } from "./artifacts.js";
import { CnogError } from "./errors.js";
import { RunController } from "./run-controller.js";
import { _git } from "./worktree.js";
import {
  appendExecutionTaskOutput,
  ensureExecutionTaskOutput,
  resetExecutionTaskNotification,
} from "./task-runtime.js";

export interface MergeResult {
  success: boolean;
  tier: string | null;
  message: string;
  conflicts: string[];
}

/** Run a git command in the project root. */
function git(projectRoot: string, ...args: string[]) {
  return _git({ cwd: projectRoot }, ...args);
}

export class MergeQueue {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly canonicalBranch: string = "main",
    private readonly projectRoot: string = process.cwd(),
    private readonly lifecycle?: Lifecycle,
  ) {}

  enqueue(opts: {
    feature: string;
    branch: string;
    agentName: string;
    runId: string;
    sessionId: string;
    taskId?: string;
    headSha: string;
    filesModified?: string[];
  }): number {
    const parentTaskId = this.resolveMergeParentTaskId({
      runId: opts.runId,
      sessionId: opts.sessionId,
      issueId: opts.taskId ?? null,
    });
    const id = this.db.merges.enqueue({
      feature: opts.feature,
      branch: opts.branch,
      agent_name: opts.agentName,
      run_id: opts.runId,
      session_id: opts.sessionId,
      task_id: opts.taskId ?? null,
      head_sha: opts.headSha,
      files_modified: opts.filesModified
        ? JSON.stringify(opts.filesModified)
        : null,
    });
    const entry = this.db.merges.listForRun(opts.runId).find((merge) => merge.id === id);
    if (entry) {
      this.ensureMergeExecutionTask(entry, parentTaskId);
    }
    this.events.mergeEnqueued(opts.branch, opts.feature, opts.agentName);
    return id;
  }

  pending(feature?: string): MergeQueueRow[] {
    return this.db.merges.pending(feature);
  }

  processNext(): MergeResult | null {
    const entries = this.db.merges.pending();
    if (entries.length === 0) return null;
    return this.processEntry(entries[0]);
  }

  processAll(): MergeResult[] {
    return this.db.merges.pending().map((entry) => this.processEntry(entry));
  }

  private processEntry(entry: MergeQueueRow): MergeResult {
    const executionTask = this.ensureMergeExecutionTask(entry);

    // Check lifecycle gating — uses run-based scope-hash matching
    if (this.lifecycle && entry.run_id) {
      const [allowed, reason] = this.lifecycle.canMerge(entry.run_id);
      if (!allowed) {
        const blockedSummary = `Merge blocked: ${reason}`;
        if (executionTask.status !== "pending" || executionTask.summary !== blockedSummary) {
          resetExecutionTaskNotification(this.db, executionTask.id, this.projectRoot);
          this.db.executionTasks.update(executionTask.id, {
            status: "pending",
            active_session_id: null,
            summary: blockedSummary,
            result_path: null,
            last_error: null,
          });
          appendExecutionTaskOutput(
            this.db,
            executionTask.id,
            `[blocked] ${reason}\n`,
            this.projectRoot,
          );
        }
        return { success: false, tier: null, message: `Merge blocked: ${reason}`, conflicts: [] };
      }
    }

    this.db.merges.updateStatus(entry.id, "merging");
    resetExecutionTaskNotification(this.db, executionTask.id, this.projectRoot);
    this.db.executionTasks.update(executionTask.id, {
      status: "running",
      active_session_id: null,
      summary: `Merging ${entry.branch} into ${this.canonicalBranch}`,
      result_path: null,
      last_error: null,
    });
    appendExecutionTaskOutput(
      this.db,
      executionTask.id,
      `\n=== merge ${entry.branch} -> ${this.canonicalBranch} (${new Date().toISOString()}) ===\n`,
      this.projectRoot,
    );

    // Tier 1: Clean merge
    const tier1 = this.tryCleanMerge(entry.branch);
    if (tier1.success) {
      this.db.merges.updateStatus(entry.id, "merged", "clean");
      const artifact = this.recordMergeArtifact(entry, "merged", tier1, "clean");
      this.db.executionTasks.update(executionTask.id, {
        status: "completed",
        active_session_id: null,
        summary: tier1.message,
        result_path: artifact.path,
        last_error: null,
      });
      appendExecutionTaskOutput(this.db, executionTask.id, `[merged] ${tier1.message}\n`, this.projectRoot);
      this.events.mergeCompleted(entry.branch, "clean");
      return tier1;
    }

    // Tier 2: Auto-resolve (keep incoming)
    const tier2 = this.tryAutoResolve(entry.branch);
    if (tier2.success) {
      this.db.merges.updateStatus(entry.id, "merged", "auto");
      const artifact = this.recordMergeArtifact(entry, "merged", tier2, "auto");
      this.db.executionTasks.update(executionTask.id, {
        status: "completed",
        active_session_id: null,
        summary: tier2.message,
        result_path: artifact.path,
        last_error: null,
      });
      appendExecutionTaskOutput(this.db, executionTask.id, `[merged] ${tier2.message}\n`, this.projectRoot);
      this.events.mergeCompleted(entry.branch, "auto");
      return tier2;
    }

    // Tier 3/4: Mark as conflict for orchestrator
    const conflicts = this.detectConflicts(entry.branch);
    this.db.merges.updateStatus(entry.id, "conflict");
    const conflictArtifact = this.recordMergeArtifact(entry, "conflict", {
      success: false,
      tier: "conflict",
      message: `Merge conflicts in ${conflicts.length} file(s). Needs AI resolution or re-plan.`,
      conflicts,
    });
    this.db.executionTasks.update(executionTask.id, {
      status: "failed",
      active_session_id: null,
      summary: `Merge conflict in ${entry.branch}`,
      result_path: conflictArtifact.path,
      last_error: conflicts.length > 0
        ? `Conflicts: ${conflicts.join(", ")}`
        : `Merge conflict while integrating ${entry.branch}`,
    });
    appendExecutionTaskOutput(
      this.db,
      executionTask.id,
      `[conflict] ${conflicts.length > 0 ? conflicts.join(", ") : entry.branch}\n`,
      this.projectRoot,
    );
    this.handleConflict(entry, conflicts);
    this.events.mergeConflict(entry.branch, conflicts);

    return {
      success: false,
      tier: "conflict",
      message: `Merge conflicts in ${conflicts.length} file(s). Needs AI resolution or re-plan.`,
      conflicts,
    };
  }

  private resolveMergeParentTaskId(opts: {
    runId: string;
    sessionId: string;
    issueId: string | null;
  }): string | null {
    if (opts.issueId) {
      const buildTask = this.db.executionTasks.getByLogicalName(
        opts.runId,
        this.buildIssueExecutionTaskLogicalName(opts.issueId),
      );
      if (!buildTask) {
        throw new CnogError("MERGE_PARENT_MISSING", { issueId: opts.issueId });
      }
      return buildTask.id;
    }

    return this.db.sessions.getById(opts.sessionId)?.execution_task_id ?? null;
  }

  private ensureMergeExecutionTask(entry: MergeQueueRow, resolvedParentTaskId?: string | null): ExecutionTaskRow {
    const logicalName = this.buildMergeExecutionTaskLogicalName(entry.id);
    const parentTaskId = resolvedParentTaskId ?? this.resolveMergeParentTaskId({
      runId: entry.run_id,
      sessionId: entry.session_id,
      issueId: entry.task_id,
    });
    const existing = this.db.executionTasks.getByLogicalName(entry.run_id, logicalName);
    if (existing) {
      ensureExecutionTaskOutput(this.db, existing.id, this.projectRoot);
      if (existing.issue_id !== entry.task_id || existing.parent_task_id !== parentTaskId) {
        this.db.executionTasks.update(existing.id, {
          issue_id: entry.task_id ?? null,
          parent_task_id: parentTaskId,
          summary: existing.summary ?? `Pending merge for ${entry.branch}`,
        });
      }
      return existing;
    }

    const taskId = `xtask-merge-${entry.id}`;
    this.db.executionTasks.create({
      id: taskId,
      run_id: entry.run_id,
      issue_id: entry.task_id ?? null,
      review_scope_id: null,
      parent_task_id: parentTaskId,
      logical_name: logicalName,
      kind: "merge",
      capability: "system",
      executor: "system",
      status: "pending",
      active_session_id: null,
      summary: `Pending merge for ${entry.branch}`,
      output_path: null,
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    ensureExecutionTaskOutput(this.db, taskId, this.projectRoot);
    return this.db.executionTasks.get(taskId)!;
  }

  private buildMergeExecutionTaskLogicalName(entryId: number): string {
    return `merge:${entryId}`;
  }

  private buildIssueExecutionTaskLogicalName(issueId: string): string {
    return `build:${issueId}`;
  }

  private ensureOnCanonical(): boolean {
    return git(this.projectRoot, "checkout", this.canonicalBranch).status === 0;
  }

  private tryCleanMerge(branch: string): MergeResult {
    if (!this.ensureOnCanonical()) {
      return { success: false, tier: "clean", message: `Failed to checkout ${this.canonicalBranch}`, conflicts: [] };
    }

    const result = git(this.projectRoot, "merge", "--no-commit", "--no-ff", branch);

    if (result.status === 0) {
      git(this.projectRoot, "commit", "-m", `merge: integrate ${branch}`);
      return { success: true, tier: "clean", message: `Clean merge of ${branch}`, conflicts: [] };
    }

    git(this.projectRoot, "merge", "--abort");
    return { success: false, tier: "clean", message: `Clean merge failed for ${branch}`, conflicts: [] };
  }

  private tryAutoResolve(branch: string): MergeResult {
    this.ensureOnCanonical();
    const result = git(this.projectRoot, "merge", "--no-ff", "-X", "theirs", branch);

    if (result.status === 0) {
      return { success: true, tier: "auto", message: `Auto-resolved merge of ${branch} (kept incoming)`, conflicts: [] };
    }

    git(this.projectRoot, "merge", "--abort");
    return { success: false, tier: "auto", message: `Auto-resolve failed for ${branch}`, conflicts: [] };
  }

  private detectConflicts(branch: string): string[] {
    git(this.projectRoot, "merge", "--no-commit", "--no-ff", branch);
    const result = git(this.projectRoot, "diff", "--name-only", "--diff-filter=U");
    git(this.projectRoot, "merge", "--abort");

    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.trim().split("\n").filter((f) => f.length > 0);
  }

  private handleConflict(entry: MergeQueueRow, conflicts: string[]): void {
    const run = this.db.runs.get(entry.run_id);
    if (!run || !this.lifecycle) return;
    const controller = new RunController(this.db, this.events, this.projectRoot);
    const { targetPhase } = controller.handleMergeConflict({
      entry,
      conflicts,
    });

    try {
      if (run.status === "merge") {
        this.lifecycle.advanceRun(entry.run_id, targetPhase, `Merge conflict on ${entry.branch}`);
      } else if (run.status === "evaluate") {
        this.lifecycle.advanceRun(entry.run_id, targetPhase, `Merge conflict on ${entry.branch}`);
      }
    } catch {
      // Preserve conflict state even if the run was already moved elsewhere.
    }
  }

  private recordMergeArtifact(
    entry: MergeQueueRow,
    status: "merged" | "conflict",
    result: MergeResult,
    resolvedTier?: string,
  ): ArtifactRow {
    const suffix = status === "merged" ? resolvedTier ?? "unknown" : "conflict";
    return persistJsonArtifact({
      db: this.db,
      artifactId: `art-merge-${entry.id}-${suffix}`,
      runId: entry.run_id,
      feature: entry.feature,
      type: "merge-record",
      filename: `merge-record-${entry.id}-${suffix}.json`,
      data: {
        mergeEntryId: entry.id,
        runId: entry.run_id,
        feature: entry.feature,
        branch: entry.branch,
        agentName: entry.agent_name,
        headSha: entry.head_sha,
        taskId: entry.task_id,
        status,
        resolvedTier: resolvedTier ?? null,
        message: result.message,
        conflicts: result.conflicts,
        recordedAt: new Date().toISOString(),
      },
      projectRoot: this.projectRoot,
      issueId: entry.task_id ?? null,
      sessionId: entry.session_id,
    });
  }
}
