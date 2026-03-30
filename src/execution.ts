/**
 * Run execution service.
 *
 * Owns builder spawning, dependency ancestry resolution, and run progression
 * after worker completions. This keeps dispatch.ts focused on issue scheduling
 * and contract dispatch, while orchestrator.ts only routes messages.
 */

import type { AgentIdentity, AgentManager } from "./agents.js";
import type { CnogDB } from "./db.js";
import type { Dispatcher, DispatchResult } from "./dispatch.js";
import type { EventEmitter } from "./events.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Message } from "./mail.js";
import type { MemoryEngine } from "./memory.js";
import type { MergeQueue } from "./merge.js";
import { loadLatestPlan } from "./planning/plan-factory.js";
import { getMaxConcurrent } from "./planning/profiles.js";
import { ContractManager } from "./contracts.js";
import { buildExecutionSpec, findPlanTaskForIssue } from "./execution-spec.js";
import { getRubric } from "./grading.js";
import { decideNextRunAction } from "./run-policy.js";
import {
  buildContractEvaluationSpec,
  buildContractReviewCompletionCommand,
  buildImplementationReviewCompletionCommand,
  buildReviewScope,
  buildRunEvaluationSpec,
} from "./review.js";

export class ExecutionEngine {
  constructor(
    private readonly db: CnogDB,
    private readonly agents: AgentManager,
    private readonly lifecycle: Lifecycle,
    private readonly memory: MemoryEngine,
    private readonly mergeQueue: MergeQueue,
    private readonly events: EventEmitter,
    private readonly dispatcher: Dispatcher,
    private readonly defaultRuntimeId: string,
    private readonly canonicalBranch: string,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  spawnAccepted(feature: string, profileName?: string, runtimeId?: string): DispatchResult[] {
    const run = this.db.runs.activeForFeature(feature) ?? this.db.runs.latestForFeature(feature);
    if (!run) {
      return [{
        agent: "",
        task: "",
        status: "error",
        error: `No run found for feature ${feature}`,
      }];
    }

    const plan = loadLatestPlan(feature, this.projectRoot);
    if (!plan || plan.tasks.length === 0) {
      return [{
        agent: "",
        task: "",
        status: "error",
        error: `No plan found for feature ${feature}`,
      }];
    }

    const effectiveRuntime = runtimeId ?? this.defaultRuntimeId;
    const effectiveProfile = profileName ?? run.profile ?? plan.profile ?? undefined;
    const contracts = new ContractManager(this.db, this.events, this.projectRoot);
    const rubric = getRubric("default");

    const ready = this.readyIssuesForRun(run.id);
    const activeCount = this.db.sessions.active().length;
    const maxWip = effectiveProfile ? getMaxConcurrent(effectiveProfile) : 4;
    let slotsAvailable = Math.max(0, maxWip - activeCount);
    const results: DispatchResult[] = [];

    const hasPendingContractReview = ready.some((issue) => {
      const contract = contracts.loadLatestForIssue(issue.id, feature);
      return contract?.status === "pending_review";
    });

    if (slotsAvailable > 0 && run.status === "contract" && hasPendingContractReview) {
      const evaluatorResult = this.spawnContractEvaluator(run.id, effectiveRuntime);
      if (evaluatorResult) {
        results.push(evaluatorResult);
        slotsAvailable = Math.max(0, slotsAvailable - 1);
      }
    }

    const acceptedReady = ready.filter((issue) => {
      const contract = contracts.loadLatestForIssue(issue.id, feature);
      return contract?.status === "accepted";
    });

    if (acceptedReady.length > 0 && run.status === "contract") {
      this.lifecycle.advanceRun(run.id, "build", "Accepted contracts available for builder dispatch");
    }

    const toDispatch = acceptedReady.slice(0, slotsAvailable);

    for (const issue of toDispatch) {
      const contract = contracts.loadLatestForIssue(issue.id, feature);
      if (!contract || contract.status !== "accepted") {
        continue;
      }

      const taskMatch = findPlanTaskForIssue(issue, plan);
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
      let identity: AgentIdentity;
      try {
        identity = this.agents.allocateIdentity(logicalAgentName);
      } catch (err) {
        results.push({
          agent: "",
          task: issue.title,
          status: "error",
          error: String(err),
        });
        continue;
      }

      const dependencyBranches = this.resolveDependencyBranches(issue.id);
      if (dependencyBranches.error) {
        results.push({
          agent: "",
          task: issue.title,
          status: "error",
          error: dependencyBranches.error,
        });
        continue;
      }

      try {
        const executionSpec = buildExecutionSpec({
          plan,
          task: taskMatch.task,
          taskIndex: taskMatch.taskIndex,
          profileName: effectiveProfile,
          projectRoot: this.projectRoot,
        });
        this.agents.spawn({
          identity,
          runtimeId: effectiveRuntime,
          capability: "builder",
          feature,
          taskPrompt: executionSpec.taskPrompt,
          taskId: issue.id,
          runId: run.id,
          fileScope: executionSpec.fileScope,
          verifyCommands: contract.verifyCommands,
          baseBranch: dependencyBranches.baseBranch,
          seedBranches: dependencyBranches.seedBranches,
          contract,
          rubric,
        });

        this.memory.claim(issue.id, identity.name);
        this.events.taskDispatched(identity.name, issue.title, feature, issue.id);

        results.push({
          agent: identity.name,
          task: issue.title,
          status: "spawned",
          contractId: contract.id,
        });
      } catch (err) {
        results.push({
          agent: identity.name,
          task: issue.title,
          status: "error",
          error: String(err),
        });
      }
    }

    return results;
  }

  handleWorkerDone(msg: Message): void {
    const session = this.db.sessions.get(msg.fromAgent);
    const payload = msg.payload ?? {};
    const feature = (payload.feature as string | undefined) ?? session?.feature ?? undefined;
    const branch = (payload.branch as string | undefined) ?? session?.branch ?? undefined;
    const headSha = (payload.head_sha as string | undefined) ?? "unknown";
    const filesModified = payload.files_modified as string[] | undefined;

    if (feature && branch && session) {
      this.mergeQueue.enqueue({
        feature,
        branch,
        agentName: msg.fromAgent,
        runId: session.run_id,
        sessionId: session.id,
        taskId: session.task_id ?? undefined,
        headSha,
        filesModified,
      });
    }

    this.db.sessions.updateState(msg.fromAgent, "completed");

    if (session?.task_id) {
      this.memory.done(session.task_id, msg.fromAgent);
    }

    if (session) {
      this.continueRun(session.run_id);
    }
  }

  continueRun(runId: string, runtimeId?: string): void {
    const run = this.db.runs.get(runId);
    if (!run) return;

    for (let iteration = 0; iteration < 4; iteration += 1) {
      const currentRun = this.db.runs.get(runId);
      if (!currentRun) return;

      const action = decideNextRunAction({
        runId,
        db: this.db,
        memory: this.memory,
        projectRoot: this.projectRoot,
      });

      if (action.kind === "idle" || action.kind === "blocked") {
        return;
      }

      if (action.kind === "propose_contracts") {
        this.dispatcher.proposeContracts(currentRun.feature, currentRun.id, undefined, currentRun.profile ?? undefined);
        continue;
      }

      if (action.kind === "spawn_contract_evaluator") {
        this.spawnContractEvaluator(currentRun.id, runtimeId ?? this.defaultRuntimeId);
        return;
      }

      if (action.kind === "spawn_builders") {
        this.spawnAccepted(currentRun.feature, currentRun.profile ?? undefined, runtimeId ?? undefined);
        return;
      }

      if (action.kind === "spawn_implementation_evaluator") {
        if (currentRun.status === "build") {
          try {
            this.lifecycle.advanceRun(runId, "evaluate", "All accepted builder tasks completed");
          } catch {
            // Another actor may have already advanced the run.
          }
        }
        this.spawnImplementationEvaluator(currentRun.id, runtimeId ?? this.defaultRuntimeId);
        return;
      }
    }
  }

  private spawnContractEvaluator(runId: string, runtimeId: string): DispatchResult | null {
    const run = this.db.runs.get(runId);
    if (!run || run.status !== "contract") return null;

    const activeEvaluator = this.db.sessions.list({ run_id: run.id }).some((session) =>
      session.capability === "evaluator"
      && session.state !== "completed"
      && session.state !== "failed"
    );
    if (activeEvaluator) return null;

    let identity: AgentIdentity;
    try {
      identity = this.agents.allocateIdentity(`evaluator-${run.feature}`);
    } catch (err) {
      return {
        agent: "",
        task: "contract review",
        status: "error",
        error: String(err),
      };
    }

    try {
      const spec = buildContractEvaluationSpec({
        runId: run.id,
        feature: run.feature,
        db: this.db,
        projectRoot: this.projectRoot,
      });
      this.agents.spawn({
        identity,
        runtimeId,
        capability: "evaluator",
        feature: run.feature,
        taskPrompt: spec.taskPrompt,
        runId: run.id,
        verifyCommands: spec.verifyCommands,
        baseBranch: this.canonicalBranch,
        completionCommand: buildContractReviewCompletionCommand(
          identity.name,
          spec.contractIds ?? [],
        ),
      });

      this.events.emit({
        source: "review",
        eventType: "contract_review_requested",
        message: `Spawned evaluator ${identity.name} for pending contracts in run ${run.id}`,
        feature: run.feature,
        agentName: identity.name,
        data: { runId: run.id },
      });

      return {
        agent: identity.name,
        task: "contract review",
        status: "spawned",
      };
    } catch {
      return null;
    }
  }

  private spawnImplementationEvaluator(runId: string, runtimeId: string): DispatchResult | null {
    const run = this.db.runs.get(runId);
    if (!run || run.status !== "evaluate") return null;

    const activeEvaluator = this.db.sessions.list({ run_id: run.id }).some((session) =>
      session.capability === "evaluator"
      && session.state !== "completed"
      && session.state !== "failed"
    );
    if (activeEvaluator) return null;

    const pendingBranches = this.db.merges.pendingForRun(run.id);
    if (pendingBranches.length === 0) return null;

    let scope = this.db.reviewScopes.activeForRun(run.id);
    if (!scope) {
      const scopeId = buildReviewScope({
        runId: run.id,
        feature: run.feature,
        db: this.db,
        projectRoot: this.projectRoot,
      });
      this.events.scopeCreated(scopeId, run.id, run.feature);
      scope = this.db.reviewScopes.get(scopeId)!;
    }

    let identity: AgentIdentity;
    try {
      identity = this.agents.allocateIdentity(`evaluator-${run.feature}`);
    } catch (err) {
      return {
        agent: "",
        task: "implementation evaluation",
        status: "error",
        error: String(err),
      };
    }

    try {
      const spec = buildRunEvaluationSpec({
        runId: run.id,
        scopeId: scope.id,
        db: this.db,
        canonicalBranch: this.canonicalBranch,
        projectRoot: this.projectRoot,
      });
      this.agents.spawn({
        identity,
        runtimeId,
        capability: "evaluator",
        feature: run.feature,
        taskPrompt: spec.taskPrompt,
        runId: run.id,
        verifyCommands: spec.verifyCommands,
        rubric: spec.rubric,
        baseBranch: this.canonicalBranch,
        completionCommand: buildImplementationReviewCompletionCommand(identity.name),
      });
      this.db.reviewScopes.updateStatus(scope.id, "evaluating");
      return {
        agent: identity.name,
        task: "implementation evaluation",
        status: "spawned",
      };
    } catch (err) {
      return {
        agent: "",
        task: "implementation evaluation",
        status: "error",
        error: String(err),
      };
    }
  }

  reconcileRuns(runtimeId?: string): void {
    const activeRuns = this.db.db.prepare(
      "SELECT id FROM runs WHERE status IN ('plan','contract','build','evaluate') ORDER BY created_at ASC",
    ).all() as Array<{ id: string }>;

    for (const run of activeRuns) {
      const activeSessions = this.db.sessions.list({ run_id: run.id })
        .filter((session) => session.state !== "completed" && session.state !== "failed");
      if (activeSessions.length > 0) continue;
      this.continueRun(run.id, runtimeId);
    }
  }

  private readyIssuesForRun(runId: string) {
    return this.memory.readyForRun(runId);
  }

  private resolveDependencyBranches(issueId: string): {
    baseBranch?: string;
    seedBranches?: string[];
    error?: string;
  } {
    const issue = this.memory.get(issueId);
    if (!issue || issue.deps.length === 0) {
      return {};
    }

    const branches = new Set<string>();

    for (const depId of issue.deps) {
      const depSession = this.db.sessions.list().find((session) =>
        session.task_id === depId && !!session.branch,
      );

      if (!depSession?.branch) {
        return {
          error: `Dependency ${depId} is complete but has no branch snapshot available`,
        };
      }

      branches.add(depSession.branch);
    }

    const ordered = [...branches];
    return {
      baseBranch: ordered[0],
      seedBranches: ordered.slice(1),
    };
  }
}
