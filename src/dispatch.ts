/**
 * Plan-to-agent bridge.
 *
 * Canonical flow:
 *   plan -> contract proposal
 *
 * Builder spawning lives in execution.ts so this module stays focused on
 * issue scheduling and contract dispatch only.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EventEmitter } from "./events.js";
import type { Lifecycle } from "./lifecycle.js";
import type { MemoryEngine } from "./memory.js";
import type { CnogDB } from "./db.js";
import { loadLatestPlan } from "./planning/plan-factory.js";
import type { Plan } from "./planning/plan-factory.js";
import { generateContract, ContractManager } from "./contracts.js";
import {
  buildExecutionSpec,
  findPlanTaskForIssue,
  planTaskKeyFor,
} from "./execution-spec.js";
import { runArtifactDir } from "./paths.js";
import type { RunRow } from "./types.js";

export interface DispatchResult {
  agent: string;
  task: string;
  status: "proposed" | "spawned" | "skipped" | "error";
  contractId?: string;
  error?: string;
  terminal?: boolean;
}

function planHash(plan: Plan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 16);
}

export class Dispatcher {
  constructor(
    private readonly db: CnogDB,
    private readonly lifecycle: Lifecycle,
    private readonly memory: MemoryEngine,
    private readonly events: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  /**
   * Dispatch a feature by proposing any missing contracts for ready work.
   */
  dispatchFeature(feature: string, profileName?: string): DispatchResult[] {
    const plan = loadLatestPlan(feature, this.projectRoot);
    if (!plan || !plan.tasks || plan.tasks.length === 0) {
      return [{
        agent: "",
        task: "",
        status: "error",
        error: `No plan found for feature ${feature}`,
      }];
    }

    const effectiveProfile = profileName ?? plan.profile ?? undefined;
    const run = this.ensureRun(feature, plan, effectiveProfile);
    return this.proposeContracts(feature, run.id, plan, effectiveProfile);
  }

  proposeContracts(
    feature: string,
    runId: string,
    plan?: Plan,
    profileName?: string,
  ): DispatchResult[] {
    const resolvedPlan = plan ?? loadLatestPlan(feature, this.projectRoot);
    if (!resolvedPlan || resolvedPlan.tasks.length === 0) {
      return [{
        agent: "",
        task: "",
        status: "error",
        error: `No plan found for feature ${feature}`,
      }];
    }

    const run = this.db.runs.get(runId);
    if (!run) {
      return [{
        agent: "",
        task: "",
        status: "error",
        error: `Run ${runId} not found`,
      }];
    }

    this.createIssuesFromPlan(resolvedPlan, feature, run.id);
    if (run.status === "plan") {
      this.lifecycle.advanceRun(run.id, "contract", "Plan artifact registered; proposing contracts");
    }

    const contracts = new ContractManager(this.db, this.events, this.projectRoot);
    const ready = this.memory.readyForRun(run.id);
    const results: DispatchResult[] = [];

    for (const issue of ready) {
      const existing = contracts.loadLatestForIssue(issue.id, feature);
      if (existing && existing.status !== "rejected" && existing.status !== "failed") {
        continue;
      }

      const taskMatch = findPlanTaskForIssue(issue, resolvedPlan);
      if (!taskMatch) {
        results.push({
          agent: "",
          task: issue.title,
          status: "skipped",
          error: "No matching plan task",
        });
        continue;
      }

      const logicalAgentName = `builder-${feature}-${issue.id.slice(3)}`;
      const agentName = this.nextConcreteAgentName(logicalAgentName);
      const executionSpec = buildExecutionSpec({
        plan: resolvedPlan,
        task: taskMatch.task,
        taskIndex: taskMatch.taskIndex,
        profileName,
        projectRoot: this.projectRoot,
      });

      const contract = generateContract({
        task: taskMatch.task,
        feature,
        agentName,
        runId: run.id,
      });
      contract.taskId = issue.id;
      contract.verifyCommands = executionSpec.verifyCommands;
      contract.fileScope = executionSpec.fileScope;

      contracts.propose(contract);
      results.push({
        agent: "",
        task: issue.title,
        status: "proposed",
        contractId: contract.id,
      });
    }

    return results;
  }
  /**
   * Create memory issues from plan tasks (idempotent).
   */
  private createIssuesFromPlan(
    plan: Plan,
    feature: string,
    runId: string,
  ): Map<string, string> {
    const issueMap = new Map<string, string>();
    const existing = this.memory.listForRun(runId);
    const existingByTaskKey = new Map<string, string>();
    const existingByTitle = new Map<string, string>();

    for (const issue of existing) {
      const key = typeof issue.metadata?.planTaskKey === "string"
        ? issue.metadata.planTaskKey
        : null;
      if (key) {
        existingByTaskKey.set(key, issue.id);
      }
      existingByTitle.set(issue.title, issue.id);
    }

    const taskKeyByName = new Map<string, string>();

    for (const [taskIndex, task] of plan.tasks.entries()) {
      const taskKey = planTaskKeyFor(plan, taskIndex);
      taskKeyByName.set(task.name, taskKey);

      const existingIssueId = existingByTaskKey.get(taskKey);
      const fallbackIssueId = existingByTitle.get(task.name);
      if (existingIssueId || fallbackIssueId) {
        const reusedIssueId = existingIssueId ?? fallbackIssueId!;
        if (!existingIssueId && fallbackIssueId) {
          const fallbackIssue = existing.find((issue) => issue.id === fallbackIssueId);
          this.db.issues.update(fallbackIssueId, {
            metadata: JSON.stringify({
              ...(fallbackIssue?.metadata ?? {}),
              planTaskKey: taskKey,
              planTaskIndex: taskIndex,
              fileScope: task.files,
            }),
          });
        }
        issueMap.set(taskKey, reusedIssueId);
        continue;
      }

      const issue = this.memory.create({
        title: task.name,
        description: task.action,
        issueType: "task",
        priority: 1,
        feature,
        runId,
        planNumber: plan.planNumber,
        metadata: {
          planTaskKey: taskKey,
          planTaskIndex: taskIndex,
          fileScope: task.files,
        },
      });

      issueMap.set(taskKey, issue.id);
    }

    for (const task of plan.tasks) {
      if (!task.blockedBy || task.blockedBy.length === 0) continue;

      const issueId = issueMap.get(taskKeyByName.get(task.name) ?? "");
      if (!issueId) continue;

      for (const depName of task.blockedBy) {
        const depId = issueMap.get(taskKeyByName.get(depName) ?? "");
        if (depId) {
          this.memory.addDep(issueId, depId);
        }
      }
    }

    return issueMap;
  }

  private ensureRun(feature: string, plan: Plan, profile?: string): RunRow {
    let run = this.db.runs.activeForFeature(feature);
    if (!run) {
      const runId = `run-${feature}-${randomUUID().slice(0, 8)}`;
      this.db.runs.create({
        id: runId,
        feature,
        plan_number: plan.planNumber,
        status: "plan",
        phase_reason: null,
        profile: profile ?? null,
        tasks: null,
        review: null,
        ship: null,
        worktree_path: null,
      });
      this.events.runCreated(runId, feature);
      run = this.db.runs.get(runId)!;
      this.db.phases.set(feature, "plan", undefined, profile);
    }

    if (!run.profile && profile) {
      this.db.runs.update(run.id, { profile });
      this.db.phases.set(feature, run.status, undefined, profile);
    }

    this.ensurePlanArtifact(run, plan);
    return this.db.runs.get(run.id)!;
  }

  private ensurePlanArtifact(run: RunRow, plan: Plan): void {
    const existing = this.db.artifacts.listByRun(run.id, "plan");
    if (existing.length > 0) return;

    const dir = runArtifactDir(run.feature, run.id, this.projectRoot);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const filename = `plan-${plan.planNumber}.json`;
    const relativePath = join(".cnog", "features", run.feature, "runs", run.id, filename);
    writeFileSync(join(dir, filename), JSON.stringify(plan, null, 2), "utf-8");

    this.db.artifacts.create({
      id: `art-plan-${run.id}`,
      run_id: run.id,
      feature: run.feature,
      type: "plan",
      path: relativePath,
      hash: planHash(plan),
      issue_id: null,
      session_id: null,
      review_scope_id: null,
    });
  }

  private nextConcreteAgentName(logicalName: string): string {
    const latest = this.db.sessions.getLatestByLogicalName(logicalName);
    if (!latest) return logicalName;
    const attempt = latest.attempt + 1;
    return `${logicalName}-r${attempt}`;
  }
}
