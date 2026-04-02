/**
 * Run execution service.
 *
 * Owns builder spawning, dependency ancestry resolution, and run progression
 * after worker completions. This keeps dispatch.ts focused on issue scheduling
 * and contract dispatch, while orchestrator.ts only routes messages.
 */

import { randomUUID } from "node:crypto";

import type { AgentIdentity, AgentManager } from "./agents.js";
import type { CnogDB } from "./db.js";
import type { Dispatcher, DispatchResult } from "./dispatch.js";
import type { EventEmitter } from "./events.js";
import type { Lifecycle } from "./lifecycle.js";
import type { Message } from "./mail.js";
import type { MemoryEngine } from "./memory.js";
import type { MergeQueue } from "./merge.js";
import type { WorktreeOptions } from "./worktree.js";
import { loadLatestPlan } from "./planning/plan-factory.js";
import { getMaxConcurrent } from "./planning/profiles.js";
import { ContractManager } from "./contracts.js";
import { buildExecutionSpec, findPlanTaskForIssue } from "./execution-spec.js";
import { CnogError } from "./errors.js";
import { getRubric } from "./grading.js";
import { decideNextRunAction } from "./run-policy.js";
import {
  buildContractEvaluationSpec,
  buildContractReviewCompletionCommand,
  buildImplementationReviewCompletionCommand,
  buildReviewScope,
  buildRunEvaluationSpec,
} from "./review.js";
import type {
  BuilderCompletionData,
  Capability,
  ExecutionTaskKind,
  ExecutionTaskRow,
  SessionRow,
} from "./types.js";
import {
  requestIssueVerification,
  requestReviewScopeVerification,
  reconcileVerificationTasks,
  type VerificationBatchOutcome,
  type VerificationRequestResult,
} from "./verify.js";
import {
  ensureExecutionTaskOutput,
  resetExecutionTaskNotification,
  supersedeExecutionTask,
  supersedeExecutionTaskDescendants,
} from "./task-runtime.js";

export type EvaluationRequestResult =
  | { status: "spawned"; agent: string; task: string }
  | { status: "idle" | "blocked"; reason: string }
  | { status: "error"; error: string; terminal?: boolean };

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
    private readonly worktreeOptions?: WorktreeOptions,
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
    const activeCount = this.activeWorkCount();
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
        this.failRunOnTerminal(run.id, evaluatorResult);
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
      const executionTask = this.ensureExecutionTask({
        runId: run.id,
        issueId: issue.id,
        logicalName: this.buildExecutionTaskLogicalName("build", issue.id),
        kind: "build",
        capability: "builder",
        summary: `Ready to build issue ${issue.title}`,
      });
      if (executionTask.status === "running" || executionTask.status === "blocked") {
        continue;
      }

      let identity: AgentIdentity;
      try {
        identity = this.agents.allocateIdentity(logicalAgentName);
      } catch (err) {
        this.markExecutionTaskFailed(executionTask.id, this.errorText(err));
        results.push(this.dispatchError(issue.title, err));
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
        resetExecutionTaskNotification(this.db, executionTask.id, this.projectRoot);
        this.agents.spawn({
          identity,
          runtimeId: effectiveRuntime,
          capability: "builder",
          feature,
          taskPrompt: executionSpec.taskPrompt,
          taskId: issue.id,
          executionTaskId: executionTask.id,
          runId: run.id,
          executionKind: "build",
          assignmentSpec: executionSpec.assignment,
          fileScope: executionSpec.fileScope,
          verifyCommands: executionSpec.packageVerifyCommands,
          dependencyBranches: dependencyBranches.seedBranches,
          baseBranch: dependencyBranches.baseBranch,
          seedBranches: dependencyBranches.seedBranches,
          contract,
          rubric,
        });

        const session = this.db.sessions.get(identity.name);
        this.db.executionTasks.update(executionTask.id, {
          status: "running",
          active_session_id: session?.id ?? null,
          summary: `Builder ${identity.name} running for ${issue.title}`,
          result_path: null,
          last_error: null,
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
        this.markExecutionTaskFailed(executionTask.id, this.errorText(err));
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

  handleWorkerDone(msg: Message, payload: BuilderCompletionData, summary: string): void {
    const session = this.db.sessions.get(msg.fromAgent);
    if (!session) {
      throw new Error(`Session ${msg.fromAgent} not found for builder completion`);
    }
    if (!session.execution_task_id || !session.task_id || !session.feature) {
      throw new Error(`Builder session ${msg.fromAgent} is missing execution task identity`);
    }

    const feature = session.feature;
    const branch = session.branch ?? "unknown";
    const headSha = payload.headSha ?? "unknown";
    const filesModified = payload.filesModified;
    this.recordBuildCompletionMetadata(session.execution_task_id, headSha, filesModified);
    this.db.sessions.updateState(msg.fromAgent, "completed");
    const verification = this.scheduleCompletedBuildVerification(session, feature, branch, summary);
    if (verification.status === "failed") {
      this.markExecutionTaskFailed(
        session.execution_task_id,
        verification.reason ?? "Post-build verification could not be scheduled",
        `Post-build verification failed for ${msg.fromAgent}`,
      );
      this.reopenIssueForRework(
        session.task_id,
        msg.fromAgent,
        verification.reason ?? "Post-build verification failed",
        "verify_failed",
      );
      this.events.emit({
        source: "execution",
        eventType: "post_build_verify_failed",
        message: `Post-build verification failed for ${msg.fromAgent}`,
        agentName: msg.fromAgent,
        feature,
        data: { runId: session.run_id, issueId: session.task_id, branch },
      });
      this.continueRun(session.run_id);
      return;
    }

    if (verification.status === "passed") {
      this.completeVerifiedBuild(session, branch, headSha, filesModified, summary, verification.artifact?.path ?? null);
      return;
    }

    this.db.executionTasks.update(session.execution_task_id, {
      status: "pending",
      active_session_id: null,
      summary: `Awaiting post-build verification for ${msg.fromAgent}: ${summary}`,
      result_path: null,
      last_error: null,
    });
  }

  handleSessionFailure(sessionName: string, reason: string): void {
    const session = this.db.sessions.get(sessionName);
    if (!session?.execution_task_id) return;

    this.markExecutionTaskFailed(
      session.execution_task_id,
      reason,
      `Failed in session ${sessionName}`,
    );

    if (session.capability === "builder" && session.task_id) {
      this.reopenIssueForRework(session.task_id, sessionName, reason, "execution_failed");
    }
  }

  handleEvaluationResult(sessionName: string, verdict?: string | null): void {
    const session = this.db.sessions.get(sessionName);
    if (!session?.execution_task_id) return;
    const outputPath = this.latestEvaluatorOutputPath(session);

    this.db.executionTasks.update(session.execution_task_id, {
      status: "completed",
      active_session_id: null,
      summary: verdict
        ? `Evaluation completed with verdict ${verdict}`
        : `Evaluation completed by ${sessionName}`,
      result_path: outputPath,
      last_error: null,
    });
  }

  requestEvaluation(feature: string, runtimeId?: string): EvaluationRequestResult {
    const run = this.lifecycle.latestRun(feature);
    if (!run) {
      return { status: "error", error: `No run found for feature ${feature}` };
    }

    const effectiveRuntime = runtimeId ?? this.defaultRuntimeId;

    if (run.status === "contract") {
      const result = this.spawnContractEvaluator(run.id, effectiveRuntime);
      this.failRunOnTerminal(run.id, result);
      return result
        ? this.toEvaluationRequestResult(result)
        : this.evaluationStateForRun(run.id);
    }

    const remainingIssues = this.db.issues
      .list({ run_id: run.id })
      .filter((issue) => issue.status === "open" || issue.status === "in_progress");
    const activeBuilders = this.hasRunningExecutionTask(run.id, "build")
      || this.hasLegacyActiveSessions(run.id, "builder");
    if (remainingIssues.length > 0 || activeBuilders) {
      return {
        status: "blocked",
        reason: `Feature ${feature} still has implementation work in flight. Finish all builders before evaluation.`,
      };
    }

    if (this.db.merges.pendingForRun(run.id).length === 0) {
      return {
        status: "blocked",
        reason: `Feature ${feature} has no completed branches ready for evaluation.`,
      };
    }

    if (run.status === "build") {
      this.lifecycle.advanceRun(run.id, "evaluate", "Manual evaluation requested");
    } else if (run.status !== "evaluate") {
      return {
        status: "blocked",
        reason: `Feature ${feature} is in ${run.status} phase. Complete implementation before evaluation.`,
      };
    }

    const result = this.spawnImplementationEvaluator(run.id, effectiveRuntime);
    this.failRunOnTerminal(run.id, result);
    return result
      ? this.toEvaluationRequestResult(result)
      : this.evaluationStateForRun(run.id);
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
        const result = this.spawnContractEvaluator(currentRun.id, runtimeId ?? this.defaultRuntimeId);
        this.failRunOnTerminal(currentRun.id, result);
        return;
      }

      if (action.kind === "spawn_builders") {
        const results = this.spawnAccepted(
          currentRun.feature,
          currentRun.profile ?? undefined,
          runtimeId ?? undefined,
        );
        const terminal = results.find((result) => result.status === "error" && result.terminal);
        this.failRunOnTerminal(currentRun.id, terminal);
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
        const result = this.spawnImplementationEvaluator(currentRun.id, runtimeId ?? this.defaultRuntimeId);
        this.failRunOnTerminal(currentRun.id, result);
        return;
      }
    }
  }

  private spawnContractEvaluator(runId: string, runtimeId: string): DispatchResult | null {
    const run = this.db.runs.get(runId);
    if (!run || run.status !== "contract") return null;

    const executionTask = this.ensureExecutionTask({
      runId: run.id,
      logicalName: this.buildExecutionTaskLogicalName("contract_review", run.id),
      kind: "contract_review",
      capability: "evaluator",
      summary: `Ready to review pending contracts for ${run.feature}`,
    });
    if (executionTask.status === "running" || executionTask.status === "blocked") return null;

    let identity: AgentIdentity;
    try {
      identity = this.agents.allocateIdentity(`evaluator-${run.feature}`);
    } catch (err) {
      this.markExecutionTaskFailed(executionTask.id, this.errorText(err));
      return this.dispatchError("contract review", err);
    }

    try {
      const spec = buildContractEvaluationSpec({
        runId: run.id,
        feature: run.feature,
        db: this.db,
        projectRoot: this.projectRoot,
      });
      resetExecutionTaskNotification(this.db, executionTask.id, this.projectRoot);
      this.agents.spawn({
        identity,
        runtimeId,
        capability: "evaluator",
        feature: run.feature,
        taskPrompt: spec.taskPrompt,
        executionTaskId: executionTask.id,
        runId: run.id,
        executionKind: "contract_review",
        assignmentSpec: spec.assignment,
        verifyCommands: spec.verifyCommands,
        baseBranch: this.canonicalBranch,
        completionCommand: buildContractReviewCompletionCommand({
          agentName: identity.name,
          runId: run.id,
          feature: run.feature,
          contractIds: spec.contractIds ?? [],
        }),
      });
      const session = this.db.sessions.get(identity.name);
      this.db.executionTasks.update(executionTask.id, {
        status: "running",
        active_session_id: session?.id ?? null,
        summary: `Evaluator ${identity.name} reviewing pending contracts`,
        result_path: null,
        last_error: null,
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
    } catch (err) {
      this.markExecutionTaskFailed(executionTask.id, this.errorText(err));
      return {
        agent: "",
        task: "contract review",
        status: "error",
        error: this.errorText(err),
      };
    }
  }

  private spawnImplementationEvaluator(runId: string, runtimeId: string): DispatchResult | null {
    const run = this.db.runs.get(runId);
    if (!run || run.status !== "evaluate") return null;

    const activeEvaluator = this.hasRunningExecutionTask(run.id, "implementation_review")
      || this.hasLegacyActiveSessions(run.id, "evaluator");
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
      const pendingTask = this.ensureExecutionTask({
        runId: run.id,
        reviewScopeId: scope.id,
        logicalName: this.buildExecutionTaskLogicalName("implementation_review", run.id),
        kind: "implementation_review",
        capability: "evaluator",
        summary: `Ready to evaluate implementation scope ${scope.id}`,
      });
      this.markExecutionTaskFailed(pendingTask.id, this.errorText(err));
      return this.dispatchError("implementation evaluation", err);
    }

    try {
      const executionTask = this.ensureExecutionTask({
        runId: run.id,
        reviewScopeId: scope.id,
        logicalName: this.buildExecutionTaskLogicalName("implementation_review", run.id),
        kind: "implementation_review",
        capability: "evaluator",
        summary: `Ready to evaluate implementation scope ${scope.id}`,
      });
      if (executionTask.status === "running" || executionTask.status === "blocked") {
        return null;
      }

      const spec = buildRunEvaluationSpec({
        runId: run.id,
        scopeId: scope.id,
        db: this.db,
        canonicalBranch: this.canonicalBranch,
        projectRoot: this.projectRoot,
      });
      const scopeVerification = this.ensureReviewScopeVerification(
        run.id,
        run.feature,
        executionTask.id,
        scope,
        spec.verifyCommands,
      );
      if (scopeVerification.status === "failed" || scopeVerification.status === "blocked") {
        this.db.executionTasks.update(executionTask.id, {
          status: "blocked",
          active_session_id: null,
          review_scope_id: scope.id,
          summary: scopeVerification.reason ?? `Review-scope verification ${scopeVerification.status}`,
          result_path: scopeVerification.artifact?.path ?? null,
          last_error: scopeVerification.reason ?? scopeVerification.status,
        });
        this.events.emit({
          source: "execution",
          eventType: scopeVerification.status === "blocked"
            ? "review_scope_verify_blocked"
            : "review_scope_verify_failed",
          message: `Review-scope verification ${scopeVerification.status} for ${scope.id}`,
          feature: run.feature,
          data: { runId: run.id, scopeId: scope.id, artifactPath: scopeVerification.artifact?.path ?? null },
        });
        return null;
      }
      if (scopeVerification.status !== "passed") {
        this.db.executionTasks.update(executionTask.id, {
          status: "pending",
          active_session_id: null,
          review_scope_id: scope.id,
          summary: `Awaiting review-scope verification for ${scope.id}`,
          result_path: null,
          last_error: null,
        });
        return null;
      }
      resetExecutionTaskNotification(this.db, executionTask.id, this.projectRoot);
      this.agents.spawn({
        identity,
        runtimeId,
        capability: "evaluator",
        feature: run.feature,
        taskPrompt: spec.taskPrompt,
        executionTaskId: executionTask.id,
        runId: run.id,
        executionKind: "implementation_review",
        reviewScopeId: scope.id,
        scopeHash: scope.scope_hash,
        assignmentSpec: spec.assignment,
        verifyCommands: [],
        rubric: spec.rubric,
        baseBranch: this.canonicalBranch,
        completionCommand: buildImplementationReviewCompletionCommand({
          agentName: identity.name,
          runId: run.id,
          feature: run.feature,
          scopeId: scope.id,
          scopeHash: scope.scope_hash,
        }),
      });
      const session = this.db.sessions.get(identity.name);
      this.db.executionTasks.update(executionTask.id, {
        status: "running",
        active_session_id: session?.id ?? null,
        review_scope_id: scope.id,
        summary: `Evaluator ${identity.name} reviewing scope ${scope.id}`,
        result_path: null,
        last_error: null,
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
        error: this.errorText(err),
      };
    }
  }

  reconcileRuns(runtimeId?: string): void {
    const verifyOutcomes = reconcileVerificationTasks({
      db: this.db,
      projectRoot: this.projectRoot,
    });
    for (const outcome of verifyOutcomes) {
      this.handleVerificationOutcome(outcome);
    }

    const activeRuns = this.db.db.prepare(
      "SELECT id FROM runs WHERE status IN ('plan','contract','build','evaluate') ORDER BY created_at ASC",
    ).all() as Array<{ id: string }>;

    for (const run of activeRuns) {
      if (this.hasRunningExecutionTask(run.id) || this.hasLegacyActiveSessions(run.id)) continue;
      this.continueRun(run.id, runtimeId);
    }
  }

  private handleVerificationOutcome(outcome: VerificationBatchOutcome): void {
    if (outcome.mode === "issue" && outcome.issueId && outcome.parentTaskId) {
      const buildTask = this.db.executionTasks.get(outcome.parentTaskId);
      if (!buildTask) {
        return;
      }
      const builderSession = this.db.sessions
        .list({ run_id: outcome.runId })
        .filter((session) => session.execution_task_id === buildTask.id)
        .sort((a, b) => {
          if (b.attempt !== a.attempt) return b.attempt - a.attempt;
          return b.started_at.localeCompare(a.started_at);
        })[0] ?? null;
      const branch = builderSession?.branch ?? "unknown";
      const headSha = buildTask.head_sha ?? "unknown";
      const filesModified = this.parseTaskFilesModified(buildTask);

      if (outcome.passed) {
        this.db.executionTasks.update(buildTask.id, {
          status: "completed",
          active_session_id: null,
          summary: `Completed and verified: ${buildTask.logical_name}`,
          result_path: outcome.artifact.path,
          last_error: null,
        });
        this.memory.done(outcome.issueId, builderSession?.name ?? "verify");
        if (builderSession) {
          this.mergeQueue.enqueue({
            feature: outcome.feature,
            branch,
            agentName: builderSession.name,
            runId: outcome.runId,
            sessionId: builderSession.id,
            taskId: outcome.issueId,
            headSha,
            filesModified,
          });
        }
        this.continueRun(outcome.runId);
        return;
      }

      if (outcome.blocked) {
        this.db.executionTasks.update(buildTask.id, {
          status: "blocked",
          active_session_id: null,
          summary: `Blocked: post-build verification for ${outcome.issueId}`,
          result_path: outcome.artifact.path,
          last_error: "interactive_input",
        });
        this.events.emit({
          source: "execution",
          eventType: "post_build_verify_blocked",
          message: `Post-build verification blocked for ${outcome.issueId}`,
          feature: outcome.feature,
          agentName: builderSession?.name ?? undefined,
          data: { runId: outcome.runId, issueId: outcome.issueId, artifactPath: outcome.artifact.path },
        });
        this.continueRun(outcome.runId);
        return;
      }

      this.db.executionTasks.update(buildTask.id, {
        status: "failed",
        active_session_id: null,
        summary: `Post-build verification failed for ${outcome.issueId}`,
        result_path: outcome.artifact.path,
        last_error: outcome.results
          .filter((result) => !result.passed)
          .map((result) => `${result.command} (${result.exitCode})`)
          .join(", "),
      });
      this.reopenIssueForRework(
        outcome.issueId,
        builderSession?.name ?? "verify",
        "Post-build verification failed",
        "verify_failed",
      );
      this.events.emit({
        source: "execution",
        eventType: "post_build_verify_failed",
        message: `Post-build verification failed for ${outcome.issueId}`,
        feature: outcome.feature,
        agentName: builderSession?.name ?? undefined,
        data: { runId: outcome.runId, issueId: outcome.issueId, artifactPath: outcome.artifact.path },
      });
      this.continueRun(outcome.runId);
      return;
    }

    if (outcome.mode === "review_scope" && outcome.parentTaskId && outcome.scopeId) {
      const task = this.db.executionTasks.get(outcome.parentTaskId);
      if (!task) return;

      if (outcome.passed) {
        this.db.executionTasks.update(task.id, {
          status: "pending",
          active_session_id: null,
          summary: `Verification passed for scope ${outcome.scopeId}; evaluator ready`,
          result_path: outcome.artifact.path,
          last_error: null,
        });
      } else {
        this.db.executionTasks.update(task.id, {
          status: "blocked",
          active_session_id: null,
          summary: outcome.blocked
            ? `Blocked: review-scope verification for ${outcome.scopeId}`
            : `Review-scope verification failed for ${outcome.scopeId}`,
          result_path: outcome.artifact.path,
          last_error: outcome.blocked ? "interactive_input" : "verify_failed",
        });
      }
      this.continueRun(outcome.runId);
    }
  }

  private completeVerifiedBuild(
    session: SessionRow,
    branch: string,
    headSha: string,
    filesModified: string[],
    summary: string,
    verificationArtifactPath: string | null,
  ): void {
    this.mergeQueue.enqueue({
      feature: session.feature ?? "unknown",
      branch,
      agentName: session.name,
      runId: session.run_id,
      sessionId: session.id,
      taskId: session.task_id ?? undefined,
      headSha,
      filesModified,
    });

    this.db.executionTasks.update(session.execution_task_id!, {
      status: "completed",
      active_session_id: null,
      summary: verificationArtifactPath
        ? `Completed and verified by ${session.name}: ${summary}`
        : `Completed by ${session.name}: ${summary}`,
      result_path: verificationArtifactPath,
      last_error: null,
    });

    if (session.task_id) {
      this.memory.done(session.task_id, session.name);
    }
    this.continueRun(session.run_id);
  }

  private readyIssuesForRun(runId: string) {
    return this.memory.readyForRun(runId);
  }

  private scheduleCompletedBuildVerification(
    session: SessionRow,
    feature: string,
    branch: string,
    summary: string,
  ): VerificationRequestResult {
    if (!session.task_id) {
      return {
        status: "failed",
        artifact: null,
        tasks: [],
        results: [],
        reason: "Builder issue identity missing for verification",
      };
    }

    const contracts = new ContractManager(this.db, this.events, this.projectRoot);
    const contract = contracts.loadLatestForIssue(session.task_id, feature);
    if (!contract || contract.verifyCommands.length === 0) {
      return { status: "passed", artifact: null, tasks: [], results: [] };
    }

    if (!session.worktree_path) {
      return {
        artifact: null,
        status: "failed",
        reason: "Builder worktree unavailable for verification",
        tasks: [],
        results: contract.verifyCommands.map((command) => ({
          command,
          passed: false,
          exitCode: 1,
          stdout: "",
          stderr: "Builder worktree unavailable for verification",
        })),
      };
    }

    const verification = requestIssueVerification({
      db: this.db,
      runId: session.run_id,
      feature,
      issueId: session.task_id,
      parentTaskId: session.execution_task_id ?? undefined,
      branch,
      worktreePath: session.worktree_path,
      commands: contract.verifyCommands,
      projectRoot: this.projectRoot,
    });

    if (verification.status === "failed") {
      this.events.emit({
        source: "execution",
        eventType: "post_build_verify_failed",
        message: `Post-build verification failed for ${session.name}`,
        agentName: session.name,
        feature,
        data: { runId: session.run_id, issueId: session.task_id, branch, summary },
      });
    }

    return verification;
  }

  private ensureReviewScopeVerification(
    runId: string,
    feature: string,
    parentTaskId: string,
    scope: { id: string; scope_hash: string; branches: string; verify_commands: string },
    verifyCommands: string[],
  ): VerificationRequestResult {
    if (verifyCommands.length === 0) {
      return { status: "passed", artifact: null, tasks: [], results: [] };
    }

    const branches = JSON.parse(scope.branches) as string[];
    return requestReviewScopeVerification({
      db: this.db,
      runId,
      feature,
      scopeId: scope.id,
      parentTaskId,
      scopeHash: scope.scope_hash,
      canonicalBranch: this.canonicalBranch,
      branches,
      commands: verifyCommands,
      projectRoot: this.projectRoot,
      worktreeOptions: this.worktreeOptions,
    });
  }

  private activeWorkCount(): number {
    const runningTasks = this.db.executionTasks.list({ status: "running" }).length;
    const legacySessions = this.db.sessions.active().filter((session) => (
      !session.execution_task_id
      && (session.state === "booting" || session.state === "working")
    )).length;
    return runningTasks + legacySessions;
  }

  private hasRunningExecutionTask(runId: string, kind?: ExecutionTaskKind): boolean {
    return this.db.executionTasks
      .list({ run_id: runId })
      .some((task) => task.status === "running" && (!kind || task.kind === kind));
  }

  private hasLegacyActiveSessions(runId: string, capability?: Capability): boolean {
    return this.db.sessions
      .list({ run_id: runId })
      .some((session) => (
        session.execution_task_id === null
        && (!capability || session.capability === capability)
        && (session.state === "booting" || session.state === "working")
      ));
  }

  private reopenIssueForRework(
    issueId: string,
    actor: string,
    reason: string,
    eventType: string,
  ): void {
    const issue = this.db.issues.get(issueId);
    if (!issue || issue.status === "done" || issue.status === "closed") {
      return;
    }
    this.db.issues.update(issueId, { status: "open", assignee: null });
    this.db.issues.logEvent({
      issue_id: issueId,
      event_type: eventType,
      actor,
      data: JSON.stringify({ reason }),
    });
  }

  private dispatchError(task: string, err: unknown): DispatchResult {
    return {
      agent: "",
      task,
      status: "error",
      error: err instanceof Error ? err.toString() : String(err),
      terminal: err instanceof CnogError && err.code === "AGENT_RETRY_EXHAUSTED",
    };
  }

  private toEvaluationRequestResult(result: DispatchResult): EvaluationRequestResult {
    if (result.status === "spawned") {
      return {
        status: "spawned",
        agent: result.agent,
        task: result.task,
      };
    }

    return {
      status: "error",
      error: result.error ?? `Failed to handle ${result.task}`,
      terminal: result.terminal,
    };
  }

  private evaluationStateForRun(runId: string): EvaluationRequestResult {
    const action = decideNextRunAction({
      runId,
      db: this.db,
      memory: this.memory,
      projectRoot: this.projectRoot,
    });

    if (action.kind === "idle" || action.kind === "blocked") {
      return {
        status: action.kind,
        reason: action.reason,
      };
    }

    return {
      status: "blocked",
      reason: action.reason,
    };
  }

  private failRunOnTerminal(runId: string, result: DispatchResult | null | undefined): void {
    if (!result || result.status !== "error" || !result.terminal) {
      return;
    }

    const run = this.db.runs.get(runId);
    if (!run || run.status === "failed" || run.status === "done") {
      return;
    }

    const reason = result.error ?? `Terminal execution error while handling ${result.task}`;
    this.lifecycle.advanceRun(runId, "failed", reason);
    this.events.emit({
      source: "execution",
      eventType: "run_failed",
      message: `Run ${runId} failed: ${reason}`,
      feature: run.feature,
      data: { runId, task: result.task },
    });
  }

  private buildExecutionTaskLogicalName(
    kind: ExecutionTaskKind,
    subject: string,
  ): string {
    return `${kind}:${subject}`;
  }

  private ensureExecutionTask(opts: {
    runId: string;
    issueId?: string;
    reviewScopeId?: string;
    parentTaskId?: string;
    logicalName: string;
    kind: ExecutionTaskKind;
    capability: Capability;
    summary: string;
  }): ExecutionTaskRow {
    const existing = this.db.executionTasks.getByLogicalName(opts.runId, opts.logicalName);
    if (existing) {
      if (existing.status === "blocked") {
        return existing;
      }
      const shouldSupersedeDescendants = existing.status !== "running" && (
        opts.kind === "build"
        || (
          opts.kind === "implementation_review"
          && existing.review_scope_id !== (opts.reviewScopeId ?? existing.review_scope_id)
        )
      );
      if (shouldSupersedeDescendants) {
        supersedeExecutionTaskDescendants(
          this.db,
          existing.id,
          `${opts.logicalName} reopened for another attempt`,
          this.projectRoot,
        );
        if (opts.kind === "build" && opts.issueId) {
          for (const mergeEntry of this.db.merges.listForRun(opts.runId)) {
            if (mergeEntry.task_id !== opts.issueId || mergeEntry.status === "merged") continue;
            const mergeTask = this.db.executionTasks.getByLogicalName(opts.runId, `merge:${mergeEntry.id}`);
            if (!mergeTask || mergeTask.status === "superseded" || mergeTask.parent_task_id === existing.id) continue;
            supersedeExecutionTask(
              this.db,
              mergeTask.id,
              `${opts.logicalName} reopened for another attempt`,
              this.projectRoot,
            );
          }
          this.db.merges.failPendingForIssue(opts.runId, opts.issueId);
        }
      }
      this.db.executionTasks.update(existing.id, {
        status: existing.status === "running"
          ? "running"
          : existing.status === "blocked"
            ? "blocked"
            : "pending",
        active_session_id: existing.status === "running" ? existing.active_session_id : null,
        parent_task_id: opts.parentTaskId ?? existing.parent_task_id,
        summary: opts.summary,
        result_path: null,
        head_sha: null,
        files_modified: null,
        last_error: null,
        review_scope_id: opts.reviewScopeId ?? existing.review_scope_id,
      });
      ensureExecutionTaskOutput(this.db, existing.id, this.projectRoot);
      resetExecutionTaskNotification(this.db, existing.id, this.projectRoot);
      return this.db.executionTasks.get(existing.id)!;
    }

    const id = `xtask-${randomUUID().slice(0, 8)}`;
    this.db.executionTasks.create({
      id,
      run_id: opts.runId,
      issue_id: opts.issueId ?? null,
      review_scope_id: opts.reviewScopeId ?? null,
      parent_task_id: opts.parentTaskId ?? null,
      logical_name: opts.logicalName,
      kind: opts.kind,
      capability: opts.capability,
      executor: "agent",
      status: "pending",
      active_session_id: null,
      summary: opts.summary,
      output_path: null,
      result_path: null,
      head_sha: null,
      files_modified: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    ensureExecutionTaskOutput(this.db, id, this.projectRoot);
    return this.db.executionTasks.get(id)!;
  }

  private recordBuildCompletionMetadata(taskId: string, headSha: string, filesModified: string[]): void {
    this.db.executionTasks.update(taskId, {
      head_sha: headSha,
      files_modified: JSON.stringify(filesModified),
    });
  }

  private parseTaskFilesModified(task: ExecutionTaskRow): string[] | undefined {
    if (!task.files_modified) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(task.files_modified) as unknown;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      return parsed.filter((value): value is string => typeof value === "string");
    } catch {
      return undefined;
    }
  }

  private markExecutionTaskFailed(
    taskId: string,
    error: string,
    summary: string = "Execution task failed",
  ): void {
    this.db.executionTasks.update(taskId, {
      status: "failed",
      active_session_id: null,
      summary,
      result_path: null,
      last_error: error,
    });
  }

  private errorText(err: unknown): string {
    return err instanceof Error ? err.toString() : String(err);
  }

  private latestEvaluatorOutputPath(session: SessionRow): string | null {
    const artifacts = this.db.artifacts
      .listByRun(session.run_id)
      .filter((artifact) =>
        artifact.session_id === session.id
        && (artifact.type === "grading-report" || artifact.type === "review-report"),
      );

    for (let i = artifacts.length - 1; i >= 0; i -= 1) {
      if (artifacts[i].type === "grading-report") {
        return artifacts[i].path;
      }
    }

    return artifacts.length > 0 ? artifacts[artifacts.length - 1].path : null;
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
