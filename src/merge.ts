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
import type { MergeQueueRow } from "./types.js";
import { persistJsonArtifact } from "./artifacts.js";
import { _git } from "./worktree.js";

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
    // Check lifecycle gating — uses run-based scope-hash matching
    if (this.lifecycle && entry.run_id) {
      const [allowed, reason] = this.lifecycle.canMerge(entry.run_id);
      if (!allowed) {
        return { success: false, tier: null, message: `Merge blocked: ${reason}`, conflicts: [] };
      }
    }

    this.db.merges.updateStatus(entry.id, "merging");

    // Tier 1: Clean merge
    const tier1 = this.tryCleanMerge(entry.branch);
    if (tier1.success) {
      this.db.merges.updateStatus(entry.id, "merged", "clean");
      this.recordMergeArtifact(entry, "merged", tier1, "clean");
      this.events.mergeCompleted(entry.branch, "clean");
      return tier1;
    }

    // Tier 2: Auto-resolve (keep incoming)
    const tier2 = this.tryAutoResolve(entry.branch);
    if (tier2.success) {
      this.db.merges.updateStatus(entry.id, "merged", "auto");
      this.recordMergeArtifact(entry, "merged", tier2, "auto");
      this.events.mergeCompleted(entry.branch, "auto");
      return tier2;
    }

    // Tier 3/4: Mark as conflict for orchestrator
    const conflicts = this.detectConflicts(entry.branch);
    this.db.merges.updateStatus(entry.id, "conflict");
    this.recordMergeArtifact(entry, "conflict", {
      success: false,
      tier: "conflict",
      message: `Merge conflicts in ${conflicts.length} file(s). Needs AI resolution or re-plan.`,
      conflicts,
    });
    this.handleConflict(entry, conflicts);
    this.events.mergeConflict(entry.branch, conflicts);

    return {
      success: false,
      tier: "conflict",
      message: `Merge conflicts in ${conflicts.length} file(s). Needs AI resolution or re-plan.`,
      conflicts,
    };
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

    if (entry.task_id) {
      this.db.issues.update(entry.task_id, { status: "open", assignee: null });
      this.db.issues.logEvent({
        issue_id: entry.task_id,
        event_type: "merge_conflict",
        actor: "merge",
        data: JSON.stringify({ branch: entry.branch, conflicts }),
      });
    }

    for (const scope of this.db.reviewScopes.listByRun(entry.run_id)) {
      if (scope.scope_status === "approved" || scope.scope_status === "evaluating") {
        this.db.reviewScopes.updateStatus(scope.id, "stale");
      }
    }

    try {
      if (run.status === "merge") {
        const target = entry.task_id ? "build" : "failed";
        this.lifecycle.advanceRun(entry.run_id, target, `Merge conflict on ${entry.branch}`);
      } else if (run.status === "evaluate") {
        const target = entry.task_id ? "build" : "failed";
        this.lifecycle.advanceRun(entry.run_id, target, `Merge conflict on ${entry.branch}`);
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
  ): void {
    const suffix = status === "merged" ? resolvedTier ?? "unknown" : "conflict";
    persistJsonArtifact({
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
