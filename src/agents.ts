/**
 * Agent lifecycle management.
 *
 * Orchestrates the full spawn pipeline:
 *   worktree creation -> overlay generation -> tmux session -> DB record
 *
 * Also handles stop, inspect, list, heartbeat.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { Capability, SessionActivity, SessionState, SprintContract, GradingRubric } from "./types.js";
import * as tmux from "./tmux.js";
import * as worktree from "./worktree.js";
import { generateOverlay, writeOverlay } from "./overlay.js";
import { CnogError } from "./errors.js";
import { persistJsonArtifact } from "./artifacts.js";
import {
  initiateHandoff,
  resumeFromHandoff,
  completeHandoff,
  loadProgressArtifact,
} from "./checkpoint.js";
import {
  DEFAULTS,
  FEATURES_DIR,
  runScratchAgentDir,
  runScratchRoleDir,
  runScratchSharedDir,
} from "./paths.js";
import { sessionTranscriptPath, sessionTranscriptRelativePath } from "./paths.js";
import { getRuntime } from "./runtimes/index.js";
import { projectFileSize, readProjectFileTail } from "./file-tail.js";
import {
  buildWorkerContextBundle,
  ensureWorkerScratchpadPaths,
} from "./context-builder.js";
import {
  appendExecutionTaskOutput,
  ensureExecutionTaskOutput,
  resetExecutionTaskNotification,
} from "./task-runtime.js";
import {
  buildBuilderCompletionCommand,
  buildGenericCompletionCommand,
  buildPlannerCompletionCommand,
  buildWorkerProtocolContract,
  buildLaunchPrompt,
  createPlannerAssignmentSpec,
  type GenericAssignmentSpec,
  type WorkerAssignmentSpec,
} from "./prompt-contract.js";
import { nextPlanNumber } from "./planning/plan-factory.js";

export interface AgentInfo {
  id: string;
  name: string;
  runtime: string;
  capability: Capability;
  feature: string;
  state: SessionState;
  branch: string | null;
  worktreePath: string | null;
  transcriptPath: string | null;
  tmuxSession: string | null;
  pid: number | null;
  parentAgent: string | null;
  startedAt: string;
  lastHeartbeat: string | null;
  durationMs?: number;
  toolUseCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  progressSummary?: string | null;
  taskLogPath?: string | null;
  lastActivityAt?: string | null;
  lastActivityKind?: string | null;
  lastActivitySummary?: string | null;
  recentActivities?: SessionActivity[];
  error: string | null;
}

export interface AgentIdentity {
  logicalName: string;
  attempt: number;
  name: string;
}

function defaultPlannerOutputPath(feature: string, projectRoot: string): string {
  return join(FEATURES_DIR, feature, `${nextPlanNumber(feature, projectRoot)}-PLAN.json`);
}

function buildDefaultAssignmentSpec(opts: {
  capability: Capability;
  feature: string;
  runId: string;
  taskPrompt: string;
  projectRoot: string;
}): WorkerAssignmentSpec {
  if (opts.capability === "planner") {
    const outputPath = defaultPlannerOutputPath(opts.feature, opts.projectRoot);
    return createPlannerAssignmentSpec({
      objective: opts.taskPrompt.trim().length > 0
        ? opts.taskPrompt
        : `Produce a structured execution plan for feature ${opts.feature}`,
      feature: opts.feature,
      runId: opts.runId,
      outputPath,
      guidance: [
        `Write the finished plan JSON to ${outputPath}.`,
        "Use schema version 3 with explicit task file scopes, verification commands, and dependency edges.",
        "Prefer disjoint file scopes for concurrent work and call out collisions when they are unavoidable.",
      ],
    });
  }

  return {
    kind: "generic_assignment",
    objective: `Complete the assigned ${opts.capability} work for feature ${opts.feature}`,
    details: opts.taskPrompt,
  } satisfies GenericAssignmentSpec;
}

export class AgentManager {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
    private readonly agentsDir: string = "agents",
    private readonly worktreeOptions?: worktree.WorktreeOptions,
  ) {}

  private readRecentTranscript(relativePath: string | null): string | null {
    const tail = readProjectFileTail(relativePath, this.projectRoot, 8_192);
    return tail?.trim().length ? tail.replace(/\n?$/, "\n") : null;
  }

  private taskLogPathForSession(executionTaskId: string | null): string | null {
    if (!executionTaskId) return null;
    return this.db.executionTasks.get(executionTaskId)?.output_path ?? null;
  }

  private buildProgressSummary(progress: {
    last_activity_summary?: string | null;
    tool_use_count?: number;
  } | undefined, taskLogPath: string | null): string | null {
    if (progress?.last_activity_summary) {
      return progress.last_activity_summary;
    }
    if (taskLogPath) {
      return `Working against ${taskLogPath}`;
    }
    if ((progress?.tool_use_count ?? 0) > 0) {
      return `${progress?.tool_use_count} tool uses recorded`;
    }
    return null;
  }

  private sessionDurationMs(startedAt: string, completedAt?: string | null): number | undefined {
    const start = Date.parse(startedAt.replace(" ", "T"));
    if (Number.isNaN(start)) return undefined;
    const end = completedAt ? Date.parse(completedAt.replace(" ", "T")) : Date.now();
    if (Number.isNaN(end)) return undefined;
    return Math.max(0, end - start);
  }

  /**
   * Spawn a new agent.
   *
   * Pipeline: validate -> worktree -> overlay -> tmux -> DB -> nudge
   */
  allocateIdentity(logicalName: string, maxRetries: number = 3): AgentIdentity {
    const latest = this.db.sessions.getLatestByLogicalName(logicalName);
    if (latest && latest.state !== "completed" && latest.state !== "failed") {
      throw new CnogError("AGENT_ALREADY_EXISTS", {
        name: latest.name,
        state: latest.state,
      });
    }

    const attempt = latest ? latest.attempt + 1 : 1;
    if (attempt > maxRetries + 1) {
      throw new CnogError("AGENT_RETRY_EXHAUSTED", {
        name: logicalName,
        retries: String(maxRetries),
      });
    }

    return {
      logicalName,
      attempt,
      name: attempt === 1 ? logicalName : `${logicalName}-r${attempt}`,
    };
  }

  spawn(opts: {
    identity: AgentIdentity;
    runtimeId: string;
    capability: Capability;
    feature: string;
    taskPrompt: string;
    taskId?: string;
    executionTaskId?: string;
    runId: string;
    executionKind?: "build" | "contract_review" | "implementation_review" | "plan" | "generic";
    reviewScopeId?: string;
    scopeHash?: string;
    assignmentSpec?: WorkerAssignmentSpec;
    fileScope?: string[];
    verifyCommands?: string[];
    dependencyBranches?: string[];
    seedBranches?: string[];
    parentAgent?: string;
    baseBranch?: string;
    contract?: SprintContract;
    rubric?: GradingRubric;
    completionCommand?: string;
  }): AgentInfo {
    // 1. Validate prerequisites
    if (!tmux.isAvailable()) {
      throw new CnogError("TMUX_NOT_INSTALLED");
    }
    const runtime = getRuntime(opts.runtimeId);

    const {
      logicalName,
      attempt,
      name: agentName,
    } = opts.identity;

    const existingByName = this.db.sessions.get(agentName);
    if (existingByName) {
      throw new CnogError("AGENT_ALREADY_EXISTS", {
        name: existingByName.name,
        state: existingByName.state,
      });
    }

    // 2. Create git worktree + branch
    let wt: worktree.Worktree;
    try {
      wt = worktree.create(
        agentName,
        opts.feature,
        opts.baseBranch ?? "main",
        this.projectRoot,
        this.worktreeOptions,
      );
    } catch (err) {
      throw new Error(`Failed to create worktree for ${agentName}: ${err}`);
    }

    if (!wt.existed && opts.seedBranches && opts.seedBranches.length > 0) {
      try {
        worktree.seedFromBranches(wt.path, opts.seedBranches);
      } catch (err) {
        worktree.remove(agentName, this.projectRoot, true);
        throw new Error(`Failed to seed dependency branches for ${agentName}: ${err}`);
      }
    }

    // 3. Check for handoff context from previous session
    const handoffContext = loadProgressArtifact(
      this.db,
      { runId: opts.runId, feature: opts.feature, logicalName },
      this.projectRoot,
    );

    // If resuming from handoff, complete the handoff record
    const pendingHandoff = resumeFromHandoff(
      this.db,
      { runId: opts.runId, feature: opts.feature, logicalName },
      this.projectRoot,
    );

    const assignmentSpec: WorkerAssignmentSpec = opts.assignmentSpec ?? buildDefaultAssignmentSpec({
      capability: opts.capability,
      feature: opts.feature,
      runId: opts.runId,
      taskPrompt: opts.taskPrompt,
      projectRoot: this.projectRoot,
    });

    const completionCommand = opts.completionCommand ?? (
      opts.capability === "builder" && opts.executionTaskId && opts.taskId
        ? buildBuilderCompletionCommand({
          agentName,
          runId: opts.runId,
          feature: opts.feature,
          executionTaskId: opts.executionTaskId,
          issueId: opts.taskId,
          branch: wt.branch,
        })
        : opts.capability === "planner"
          ? buildPlannerCompletionCommand({
            agentName,
            runId: opts.runId,
            feature: opts.feature,
            planPath: assignmentSpec.kind === "planner_assignment"
              ? assignmentSpec.outputPath
              : defaultPlannerOutputPath(opts.feature, this.projectRoot),
          })
          : buildGenericCompletionCommand({
            agentName,
            runId: opts.runId,
            feature: opts.feature,
            role: opts.capability,
          })
    );

    const usesReviewResultContract = opts.capability === "evaluator" && !!opts.completionCommand;

    const protocol = buildWorkerProtocolContract({
      role: opts.capability,
      executionKind: opts.executionKind ?? "generic",
      agentName,
      feature: opts.feature,
      runId: opts.runId,
      executionTaskId: opts.executionTaskId,
      issueId: opts.taskId,
      reviewScopeId: opts.reviewScopeId,
      scopeHash: opts.scopeHash,
      branch: wt.branch,
      fileScope: opts.fileScope,
      dependencyBranches: opts.dependencyBranches,
      localSanityChecks: opts.verifyCommands,
      completionCommand,
      resultPayloadKind: opts.capability === "builder" && opts.executionTaskId && opts.taskId
        ? "builder_completion"
        : opts.capability === "planner"
          ? "planner_completion"
          : usesReviewResultContract
            ? (opts.executionKind === "contract_review" ? "contract_review" : "implementation_review")
            : "generic_completion",
      resultRequiredFields: opts.capability === "builder" && opts.executionTaskId && opts.taskId
        ? ["summary"]
        : opts.capability === "planner"
          ? ["summary", "planPath", "taskCount"]
          : usesReviewResultContract && opts.executionKind === "contract_review"
            ? ["summary", "contracts"]
            : usesReviewResultContract
              ? ["summary", "scopeId", "scopeHash", "verdict", "scores"]
            : ["summary", "role"],
      escalationCodes: opts.capability === "planner"
        ? ["need_clarification", "unexpected_repo_state"]
        : ["scope_violation_required", "missing_dependency", "verification_drift", "unexpected_repo_state", "external_blocker"],
    });
    const scratchpad = ensureWorkerScratchpadPaths({
      feature: opts.feature,
      runId: opts.runId,
      role: opts.capability,
      agentName,
      projectRoot: this.projectRoot,
    });
    const contextBundle = buildWorkerContextBundle({
      db: this.db,
      projectRoot: this.projectRoot,
      runId: opts.runId,
      feature: opts.feature,
      role: opts.capability,
      logicalName,
      worktreePath: wt.path,
      scratchpad,
      assignment: assignmentSpec,
      canonicalBranch: opts.baseBranch,
      branch: wt.branch,
      issueId: opts.taskId,
      reviewScopeId: opts.reviewScopeId,
      dependencyBranches: opts.dependencyBranches,
      contract: opts.contract,
    });

    // 4. Generate and write the runtime instruction file
    try {
      const overlayContent = generateOverlay({
        protocol,
        assignment: assignmentSpec,
        context: contextBundle,
        agentsDir: this.agentsDir,
        contract: opts.contract,
        rubric: opts.rubric,
        handoffContext: handoffContext ?? undefined,
      });
      writeOverlay(wt.path, runtime.instructionFile, overlayContent);
      persistJsonArtifact({
        db: this.db,
        artifactId: `art-prompt-${opts.runId}-${agentName}`,
        runId: opts.runId,
        feature: opts.feature,
        type: "prompt-contract",
        filename: `prompt-contract-${agentName}.json`,
        data: {
          protocol,
          context: contextBundle,
          assignment: assignmentSpec,
          launchPrompt: buildLaunchPrompt(assignmentSpec, runtime.instructionFile),
          instructionFile: runtime.instructionFile,
          generatedAt: new Date().toISOString(),
        },
        projectRoot: this.projectRoot,
        issueId: opts.taskId ?? null,
      });
    } catch (err) {
      // Rollback worktree on overlay failure
      worktree.remove(agentName, this.projectRoot, true);
      throw new Error(`Failed to write overlay for ${agentName}: ${err}`);
    }

    // 5. Let the runtime prepare any worktree-local state it needs.
    runtime.prepareWorkspace?.({
      worktreePath: wt.path,
      agentName,
      capability: opts.capability,
      fileScope: opts.fileScope,
    });

    // 6. Create tmux session with runtime command
    const sessionName = tmux.sessionNameFor(agentName);
    const command = runtime.buildCommand({ sessionName, workingDir: wt.path, agentName });
    const pid = tmux.spawnSession(sessionName, wt.path, command);

    if (pid === null) {
      // Rollback worktree on tmux failure
      worktree.remove(agentName, this.projectRoot, true);
      throw new Error(`Failed to create tmux session for ${agentName}`);
    }

    const transcriptPath = sessionTranscriptPath(opts.feature, opts.runId, agentName, this.projectRoot);
    const transcriptRelativePath = sessionTranscriptRelativePath(opts.feature, opts.runId, agentName);
    mkdirSync(dirname(transcriptPath), { recursive: true });
    if (!existsSync(transcriptPath)) {
      writeFileSync(transcriptPath, "", "utf-8");
    }
    const pipeTargets = [transcriptPath];
    if (opts.executionTaskId) {
      resetExecutionTaskNotification(this.db, opts.executionTaskId, this.projectRoot);
      const taskOutputPath = ensureExecutionTaskOutput(this.db, opts.executionTaskId, this.projectRoot);
      appendExecutionTaskOutput(
        this.db,
        opts.executionTaskId,
        `\n=== attempt ${attempt}: ${agentName} (${new Date().toISOString()}) ===\n`,
        this.projectRoot,
      );
      pipeTargets.push(taskOutputPath);
    }
    if (!tmux.pipePaneToFiles(sessionName, pipeTargets)) {
      tmux.killSession(sessionName);
      worktree.remove(agentName, this.projectRoot, true);
      throw new Error(`Failed to enable transcript capture for ${agentName}`);
    }

    // 7. Record in database
    const id = randomUUID();
    this.db.sessions.create({
      id,
      name: agentName,
      logical_name: logicalName,
      attempt,
      runtime: runtime.id,
      capability: opts.capability,
      feature: opts.feature,
      task_id: opts.taskId ?? null,
      execution_task_id: opts.executionTaskId ?? null,
      worktree_path: wt.path,
      transcript_path: transcriptRelativePath,
      branch: wt.branch,
      tmux_session: sessionName,
      pid,
      state: "booting",
      parent_agent: opts.parentAgent ?? null,
      run_id: opts.runId,
    });
    this.db.sessionProgress.ensureFromSession(id);
    this.db.sessionProgress.update(id, {
      run_id: opts.runId,
      execution_task_id: opts.executionTaskId ?? null,
      transcript_path: transcriptRelativePath,
      transcript_size: projectFileSize(transcriptRelativePath, this.projectRoot),
    });

    this.events.agentSpawned(agentName, opts.capability, opts.feature, wt.branch);

    // Complete pending handoff if resuming
    if (pendingHandoff) {
      completeHandoff(
        this.db,
        { runId: opts.runId, feature: opts.feature, logicalName },
        pendingHandoff.fromSessionId,
        id,
        this.projectRoot,
      );
    }

    // 8. Synchronous boot delay, then send task
    spawnSync("sleep", [String(DEFAULTS.bootDelayMs / 1000)]);
    tmux.sendKeys(sessionName, buildLaunchPrompt(assignmentSpec, runtime.instructionFile));
    this.db.sessions.updateState(agentName, "working");

    return {
      id,
      name: agentName,
      runtime: runtime.id,
      capability: opts.capability as Capability,
      feature: opts.feature,
      state: "working",
      branch: wt.branch,
      worktreePath: wt.path,
      transcriptPath: transcriptRelativePath,
      tmuxSession: sessionName,
      pid,
      parentAgent: opts.parentAgent ?? null,
      startedAt: new Date().toISOString(),
      lastHeartbeat: null,
      durationMs: 0,
      toolUseCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      progressSummary: null,
      taskLogPath: opts.executionTaskId ? this.taskLogPathForSession(opts.executionTaskId) : null,
      lastActivityAt: null,
      lastActivityKind: null,
      lastActivitySummary: null,
      recentActivities: [],
      error: null,
    };
  }

  /**
   * Stop an agent: kill tmux, optionally clean up worktree.
   */
  stop(name: string, opts?: { force?: boolean; clean?: boolean }): void {
    const session = this.db.sessions.get(name);
    if (!session) {
      throw new CnogError("AGENT_NOT_FOUND", { name });
    }

    // Kill tmux session
    if (session.tmux_session) {
      tmux.killSession(session.tmux_session);
    }

    // Update state
    this.db.sessions.updateState(name, "failed", "stopped by user");
    this.events.agentStopped(name, "stopped by user");

    // Clean up worktree if requested
    if (opts?.clean) {
      worktree.remove(name, this.projectRoot, opts.force);
      if (session.feature) {
        worktree.deleteBranch(session.feature, name, this.projectRoot, opts.force);
      }
    }
  }

  /**
   * Inspect an agent: session info + recent tmux output.
   */
  inspect(name: string): { session: AgentInfo; recentOutput: string | null } | undefined {
    const session = this.db.sessions.get(name);
    if (!session) return undefined;
    const progress = this.db.sessionProgress.get(session.id);
    const taskLogPath = this.taskLogPathForSession(session.execution_task_id);

    const recentOutput = this.readRecentTranscript(session.transcript_path);

    return {
      session: {
        id: session.id,
        name: session.name,
        runtime: session.runtime,
        capability: session.capability as Capability,
        feature: session.feature ?? "",
        state: session.state as SessionState,
        branch: session.branch,
        worktreePath: session.worktree_path,
        transcriptPath: session.transcript_path,
        tmuxSession: session.tmux_session,
        pid: session.pid,
        parentAgent: session.parent_agent,
        startedAt: session.started_at,
        lastHeartbeat: session.last_heartbeat,
        durationMs: this.sessionDurationMs(session.started_at, session.completed_at),
        toolUseCount: progress?.tool_use_count ?? 0,
        inputTokens: progress?.input_tokens ?? 0,
        outputTokens: progress?.output_tokens ?? 0,
        costUsd: progress?.cost_usd ?? 0,
        progressSummary: this.buildProgressSummary(progress, taskLogPath),
        taskLogPath,
        lastActivityAt: progress?.last_activity_at ?? null,
        lastActivityKind: progress?.last_activity_kind ?? null,
        lastActivitySummary: progress?.last_activity_summary ?? null,
        recentActivities: progress
          ? JSON.parse(progress.recent_activities_json) as SessionActivity[]
          : [],
        error: session.error,
      },
      recentOutput,
    };
  }

  /**
   * List agents with optional state filter.
   */
  list(opts?: { state?: string; feature?: string }): AgentInfo[] {
    const rows = this.db.sessions.list(opts);
    return rows.map((row) => {
      const progress = this.db.sessionProgress.get(row.id);
      const taskLogPath = this.taskLogPathForSession(row.execution_task_id);
      return {
        id: row.id,
        name: row.name,
        runtime: row.runtime,
        capability: row.capability as Capability,
        feature: row.feature ?? "",
        state: row.state as SessionState,
        branch: row.branch,
        worktreePath: row.worktree_path,
        transcriptPath: row.transcript_path,
        tmuxSession: row.tmux_session,
        pid: row.pid,
        parentAgent: row.parent_agent,
        startedAt: row.started_at,
        lastHeartbeat: row.last_heartbeat,
        durationMs: this.sessionDurationMs(row.started_at, row.completed_at),
        toolUseCount: progress?.tool_use_count ?? 0,
        inputTokens: progress?.input_tokens ?? 0,
        outputTokens: progress?.output_tokens ?? 0,
        costUsd: progress?.cost_usd ?? 0,
        progressSummary: this.buildProgressSummary(progress, taskLogPath),
        taskLogPath,
        lastActivityAt: progress?.last_activity_at ?? null,
        lastActivityKind: progress?.last_activity_kind ?? null,
        lastActivitySummary: progress?.last_activity_summary ?? null,
        recentActivities: progress
          ? JSON.parse(progress.recent_activities_json) as SessionActivity[]
          : [],
        error: row.error,
      };
    });
  }

  /**
   * Get active (non-terminal) agents.
   */
  active(): AgentInfo[] {
    const rows = this.db.sessions.active();
    return rows.map((row) => {
      const progress = this.db.sessionProgress.get(row.id);
      const taskLogPath = this.taskLogPathForSession(row.execution_task_id);
      return {
        id: row.id,
        name: row.name,
        runtime: row.runtime,
        capability: row.capability as Capability,
        feature: row.feature ?? "",
        state: row.state as SessionState,
        branch: row.branch,
        worktreePath: row.worktree_path,
        transcriptPath: row.transcript_path,
        tmuxSession: row.tmux_session,
        pid: row.pid,
        parentAgent: row.parent_agent,
        startedAt: row.started_at,
        lastHeartbeat: row.last_heartbeat,
        durationMs: this.sessionDurationMs(row.started_at, row.completed_at),
        toolUseCount: progress?.tool_use_count ?? 0,
        inputTokens: progress?.input_tokens ?? 0,
        outputTokens: progress?.output_tokens ?? 0,
        costUsd: progress?.cost_usd ?? 0,
        progressSummary: this.buildProgressSummary(progress, taskLogPath),
        taskLogPath,
        lastActivityAt: progress?.last_activity_at ?? null,
        lastActivityKind: progress?.last_activity_kind ?? null,
        lastActivitySummary: progress?.last_activity_summary ?? null,
        recentActivities: progress
          ? JSON.parse(progress.recent_activities_json) as SessionActivity[]
          : [],
        error: row.error,
      };
    });
  }

  /**
   * Record a heartbeat for an agent.
   */
  heartbeat(name: string): void {
    const session = this.db.sessions.get(name);
    if (!session) {
      throw new CnogError("AGENT_NOT_FOUND", { name });
    }
    this.db.sessions.heartbeat(name);
  }

  /**
   * Save a checkpoint for an agent (for context reset handoff).
   */
  checkpoint(name: string, opts: {
    progressSummary: string;
    pendingWork: string;
    filesModified?: string[];
    verifyResults?: Record<string, boolean>;
    reason?: "compaction" | "crash" | "manual" | "timeout" | "completed";
  }): void {
    const session = this.db.sessions.get(name);
    if (!session) {
      throw new CnogError("AGENT_NOT_FOUND", { name });
    }
    const progress = this.db.sessionProgress.get(session.id);
    const taskLogPath = this.taskLogPathForSession(session.execution_task_id);
    const transcriptTail = readProjectFileTail(session.transcript_path, this.projectRoot, 2_048);
    const taskLogTail = readProjectFileTail(taskLogPath, this.projectRoot, 2_048);

    initiateHandoff(
      {
        agentName: name,
        logicalName: session.logical_name,
        runId: session.run_id,
        feature: session.feature ?? "",
        taskId: session.task_id ?? "",
        sessionId: session.id,
        timestamp: new Date().toISOString(),
        progressSummary: opts.progressSummary,
        filesModified: opts.filesModified ?? [],
        currentBranch: session.branch ?? "",
        pendingWork: opts.pendingWork,
        verifyResults: opts.verifyResults ?? {},
        resumeContext: {
          transcriptPath: session.transcript_path,
          taskLogPath,
          transcriptTail,
          taskLogTail,
          lastActivityAt: progress?.last_activity_at ?? null,
          lastActivitySummary: progress?.last_activity_summary ?? null,
          toolUseCount: progress?.tool_use_count ?? 0,
          durationMs: this.sessionDurationMs(session.started_at, session.completed_at) ?? null,
          inputTokens: progress?.input_tokens ?? 0,
          outputTokens: progress?.output_tokens ?? 0,
          costUsd: progress?.cost_usd ?? 0,
          recentActivities: progress
            ? JSON.parse(progress.recent_activities_json) as SessionActivity[]
            : [],
          scratchpad: {
            shared: runScratchSharedDir(session.feature ?? "", session.run_id, this.projectRoot),
            role: runScratchRoleDir(session.feature ?? "", session.run_id, session.capability, this.projectRoot),
            agent: runScratchAgentDir(session.feature ?? "", session.run_id, session.capability, session.name, this.projectRoot),
          },
        },
      },
      opts.reason ?? "manual",
      this.db,
      this.projectRoot,
    );
  }
}
