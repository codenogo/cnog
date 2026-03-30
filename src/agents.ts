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

import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { Capability, SessionState, SprintContract, GradingRubric } from "./types.js";
import * as tmux from "./tmux.js";
import * as worktree from "./worktree.js";
import { generateOverlay, writeOverlay } from "./overlay.js";
import { CnogError } from "./errors.js";
import {
  initiateHandoff,
  resumeFromHandoff,
  completeHandoff,
  loadProgressArtifact,
} from "./checkpoint.js";
import { DEFAULTS } from "./paths.js";
import { getRuntime } from "./runtimes/index.js";

export interface AgentInfo {
  id: string;
  name: string;
  runtime: string;
  capability: Capability;
  feature: string;
  state: SessionState;
  branch: string | null;
  worktreePath: string | null;
  tmuxSession: string | null;
  pid: number | null;
  parentAgent: string | null;
  startedAt: string;
  lastHeartbeat: string | null;
  error: string | null;
}

export interface AgentIdentity {
  logicalName: string;
  attempt: number;
  name: string;
}

export class AgentManager {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
    private readonly agentsDir: string = "agents",
  ) {}

  /**
   * Spawn a new agent.
   *
   * Pipeline: validate -> worktree -> overlay -> tmux -> DB -> nudge
   */
  allocateIdentity(logicalName: string): AgentIdentity {
    const latest = this.db.sessions.getLatestByLogicalName(logicalName);
    if (latest && latest.state !== "completed" && latest.state !== "failed") {
      throw new CnogError("AGENT_ALREADY_EXISTS", {
        name: latest.name,
        state: latest.state,
      });
    }

    const attempt = latest ? latest.attempt + 1 : 1;
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
    runId: string;
    fileScope?: string[];
    verifyCommands?: string[];
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
      );
    } catch (err) {
      throw new Error(`Failed to create worktree for ${agentName}: ${err}`);
    }

    if (opts.seedBranches && opts.seedBranches.length > 0) {
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

    // 4. Generate and write the runtime instruction file
    try {
      const overlayContent = generateOverlay({
        agentName,
        capability: opts.capability,
        feature: opts.feature,
        branch: wt.branch,
        taskId: opts.taskId,
        taskPrompt: opts.taskPrompt,
        runId: opts.runId,
        fileScope: opts.fileScope,
        verifyCommands: opts.verifyCommands,
        agentsDir: this.agentsDir,
        contract: opts.contract,
        rubric: opts.rubric,
        handoffContext: handoffContext ?? undefined,
        completionCommand: opts.completionCommand,
      });
      writeOverlay(wt.path, runtime.instructionFile, overlayContent);
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
      worktree_path: wt.path,
      branch: wt.branch,
      tmux_session: sessionName,
      pid,
      state: "booting",
      parent_agent: opts.parentAgent ?? null,
      run_id: opts.runId,
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
    tmux.sendKeys(sessionName, opts.taskPrompt);
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
      tmuxSession: sessionName,
      pid,
      parentAgent: opts.parentAgent ?? null,
      startedAt: new Date().toISOString(),
      lastHeartbeat: null,
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

    const recentOutput = session.tmux_session
      ? tmux.capturePane(session.tmux_session)
      : null;

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
        tmuxSession: session.tmux_session,
        pid: session.pid,
        parentAgent: session.parent_agent,
        startedAt: session.started_at,
        lastHeartbeat: session.last_heartbeat,
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
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      runtime: row.runtime,
      capability: row.capability as Capability,
      feature: row.feature ?? "",
      state: row.state as SessionState,
      branch: row.branch,
      worktreePath: row.worktree_path,
      tmuxSession: row.tmux_session,
      pid: row.pid,
      parentAgent: row.parent_agent,
      startedAt: row.started_at,
      lastHeartbeat: row.last_heartbeat,
      error: row.error,
    }));
  }

  /**
   * Get active (non-terminal) agents.
   */
  active(): AgentInfo[] {
    const rows = this.db.sessions.active();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      runtime: row.runtime,
      capability: row.capability as Capability,
      feature: row.feature ?? "",
      state: row.state as SessionState,
      branch: row.branch,
      worktreePath: row.worktree_path,
      tmuxSession: row.tmux_session,
      pid: row.pid,
      parentAgent: row.parent_agent,
      startedAt: row.started_at,
      lastHeartbeat: row.last_heartbeat,
      error: row.error,
    }));
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
      },
      opts.reason ?? "manual",
      this.db,
      this.projectRoot,
    );
  }
}
