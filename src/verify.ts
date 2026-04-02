import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";

import type { CnogDB } from "./db.js";
import type { ArtifactRow, ExecutionTaskRow } from "./types.js";
import { persistJsonArtifact, loadArtifactJson } from "./artifacts.js";
import { projectFileSize, readProjectFileTail, resolveProjectPath } from "./file-tail.js";
import { looksInteractivePrompt } from "./prompt-detection.js";
import {
  cleanupReviewScopeVerifierWorktree,
  reviewScopeVerifierName,
} from "./verify-worktree.js";
import * as worktree from "./worktree.js";
import {
  appendExecutionTaskOutput,
  ensureExecutionTaskOutput,
  resetExecutionTaskNotification,
  supersedeExecutionTask,
} from "./task-runtime.js";
import { executionTaskOutputRelativePath } from "./paths.js";

const VERIFY_STALL_THRESHOLD_MS = 45_000;
const VERIFY_RESULT_TAIL_BYTES = 8_192;

export interface VerifyCommandResult {
  command: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputPath?: string;
}

export interface VerifyReportArtifact {
  runId: string;
  feature: string;
  mode?: "canonical" | "issue" | "review_scope";
  scopeId?: string;
  scopeHash?: string;
  canonicalBranch?: string;
  issueId?: string;
  branch?: string;
  branches?: string[];
  worktreePath?: string;
  passed: boolean;
  results: VerifyCommandResult[];
  verifiedAt: string;
}

export interface VerificationRequestResult {
  status: "scheduled" | "running" | "passed" | "failed" | "blocked";
  artifact: ArtifactRow | null;
  tasks: ExecutionTaskRow[];
  results: VerifyCommandResult[];
  reason?: string;
}

export interface VerificationBatchOutcome {
  mode: "canonical" | "issue" | "review_scope";
  runId: string;
  feature: string;
  issueId?: string;
  scopeId?: string;
  parentTaskId?: string;
  artifact: ArtifactRow;
  tasks: ExecutionTaskRow[];
  results: VerifyCommandResult[];
  passed: boolean;
  blocked: boolean;
}

export interface VerifyRuntime {
  nowMs(): number;
  spawn(command: string, cwd: string, outputPath: string, exitPath: string): number;
  isPidAlive(pid: number): boolean;
  kill(pid: number): void;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const DEFAULT_RUNTIME: VerifyRuntime = {
  nowMs: () => Date.now(),
  spawn(command, cwd, outputPath, exitPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    mkdirSync(dirname(exitPath), { recursive: true });
    const stdoutFd = openSync(outputPath, "a");
    const stderrFd = openSync(outputPath, "a");
    const wrapper = [
      "set +e",
      `trap 'status=$?; printf \"%s\" \"$status\" > ${shellQuote(exitPath)}' EXIT`,
      command,
    ].join("\n");

    try {
      const child = spawn("sh", ["-lc", wrapper], {
        cwd,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      if (!child.pid) {
        throw new Error(`Failed to spawn verify command: ${command}`);
      }
      child.unref();
      return child.pid;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  },
  isPidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill(pid) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  },
};

interface VerifyBatchDescriptor {
  mode: "canonical" | "issue" | "review_scope";
  runId: string;
  feature: string;
  targetKey: string;
  commands: string[];
  cwd: string;
  issueId?: string;
  scopeId?: string;
  parentTaskId?: string;
  scopeHash?: string;
  canonicalBranch?: string;
  branch?: string;
  branches?: string[];
}

interface VerifyManagerOptions {
  projectRoot?: string;
  runtime?: VerifyRuntime;
  worktreeOptions?: worktree.WorktreeOptions;
}

function safeVerifyKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function canonicalVerifyTargetKey(scopeId: string): string {
  return `canonical-${scopeId}`;
}

function taskIdFor(targetKey: string, index: number): string {
  return `xtask-verify-${safeVerifyKey(targetKey)}-${String(index).padStart(2, "0")}`;
}

export function buildVerifyExecutionTaskLogicalName(targetKey: string, index: number): string {
  return `verify:${targetKey}:${String(index).padStart(2, "0")}`;
}

function resolveMode(task: ExecutionTaskRow): "canonical" | "issue" | "review_scope" {
  if (task.issue_id) return "issue";
  if (task.review_scope_id && task.parent_task_id) return "review_scope";
  return "canonical";
}

function isoNow(runtime: VerifyRuntime): string {
  return new Date(runtime.nowMs()).toISOString().replace("T", " ").slice(0, 19);
}

function summarizeFailure(command: string, exitCode: number, output: string | null): string {
  const text = output?.trim();
  if (text) {
    return `Exit ${exitCode}: ${text.split("\n").slice(-1)[0]}`;
  }
  return `Exit ${exitCode}: ${command}`;
}

export class VerifyManager {
  private readonly projectRoot: string;
  private readonly runtime: VerifyRuntime;
  private readonly worktreeOptions?: worktree.WorktreeOptions;

  constructor(
    private readonly db: CnogDB,
    opts: VerifyManagerOptions = {},
  ) {
    this.projectRoot = opts.projectRoot ?? process.cwd();
    this.runtime = opts.runtime ?? DEFAULT_RUNTIME;
    this.worktreeOptions = opts.worktreeOptions;
  }

  requestCanonicalVerification(opts: {
    runId: string;
    feature: string;
    scopeId: string;
    scopeHash: string;
    canonicalBranch: string;
    commands: string[];
  }): VerificationRequestResult {
    if (opts.commands.length === 0) {
      return { status: "passed", artifact: null, tasks: [], results: [] };
    }

    const existing = this.latestScopeArtifact(opts.runId, opts.scopeId, opts.scopeHash, "canonical");
    if (existing) {
      const report = loadArtifactJson<VerifyReportArtifact>(existing, this.projectRoot);
      if (report?.passed) {
        return {
          status: "passed",
          artifact: existing,
          tasks: this.listBatchTasks({
            mode: "canonical",
            runId: opts.runId,
            feature: opts.feature,
            targetKey: opts.scopeId,
            commands: opts.commands,
            cwd: this.projectRoot,
            scopeId: opts.scopeId,
          }),
          results: report.results,
        };
      }
    }

    const descriptor: VerifyBatchDescriptor = {
      mode: "canonical",
      runId: opts.runId,
      feature: opts.feature,
      targetKey: canonicalVerifyTargetKey(opts.scopeId),
      commands: opts.commands,
      cwd: this.projectRoot,
      scopeId: opts.scopeId,
      scopeHash: opts.scopeHash,
      canonicalBranch: opts.canonicalBranch,
    };

    return this.requestBatch(descriptor);
  }

  requestIssueVerification(opts: {
    runId: string;
    feature: string;
    issueId: string;
    parentTaskId?: string;
    branch: string;
    worktreePath: string;
    commands: string[];
  }): VerificationRequestResult {
    if (opts.commands.length === 0) {
      return { status: "passed", artifact: null, tasks: [], results: [] };
    }

    const descriptor: VerifyBatchDescriptor = {
      mode: "issue",
      runId: opts.runId,
      feature: opts.feature,
      targetKey: opts.issueId,
      commands: opts.commands,
      cwd: opts.worktreePath,
      issueId: opts.issueId,
      parentTaskId: opts.parentTaskId,
      branch: opts.branch,
    };

    return this.requestBatch(descriptor);
  }

  requestReviewScopeVerification(opts: {
    runId: string;
    feature: string;
    scopeId: string;
    parentTaskId?: string;
    scopeHash: string;
    canonicalBranch: string;
    branches: string[];
    commands: string[];
  }): VerificationRequestResult {
    if (opts.commands.length === 0) {
      return { status: "passed", artifact: null, tasks: [], results: [] };
    }

    const existing = this.latestScopeArtifact(opts.runId, opts.scopeId, opts.scopeHash, "review_scope");
    if (existing) {
      const report = loadArtifactJson<VerifyReportArtifact>(existing, this.projectRoot);
      return {
        status: report?.passed ? "passed" : "failed",
        artifact: existing,
        tasks: this.listBatchTasks({
          mode: "review_scope",
          runId: opts.runId,
          feature: opts.feature,
          targetKey: opts.scopeId,
          commands: opts.commands,
          cwd: this.reviewScopeWorktreePath(opts.scopeId),
          scopeId: opts.scopeId,
          parentTaskId: opts.parentTaskId,
        }),
        results: report?.results ?? [],
      };
    }

    const descriptor: VerifyBatchDescriptor = {
      mode: "review_scope",
      runId: opts.runId,
      feature: opts.feature,
      targetKey: opts.scopeId,
      commands: opts.commands,
      cwd: this.reviewScopeWorktreePath(opts.scopeId),
      scopeId: opts.scopeId,
      parentTaskId: opts.parentTaskId,
      scopeHash: opts.scopeHash,
      canonicalBranch: opts.canonicalBranch,
      branches: opts.branches,
    };

    return this.requestBatch(descriptor, () => this.prepareReviewScopeWorktree(descriptor));
  }

  reconcile(runId?: string): VerificationBatchOutcome[] {
    const batches = new Map<string, VerifyBatchDescriptor>();

    for (const task of this.db.executionTasks.list({ run_id: runId, kind: "verify" })) {
      if (task.result_path && task.status !== "running" && task.status !== "pending") continue;
      const descriptor = this.descriptorFromTask(task);
      batches.set(this.batchKey(descriptor), descriptor);
    }

    const outcomes: VerificationBatchOutcome[] = [];
    for (const descriptor of batches.values()) {
      const outcome = this.reconcileBatch(descriptor);
      if (outcome) {
        outcomes.push(outcome);
      }
    }
    return outcomes;
  }

  private requestBatch(
    descriptor: VerifyBatchDescriptor,
    prepare?: () => void,
  ): VerificationRequestResult {
    let existingTasks = this.listBatchTasks(descriptor);
    const hasInFlight = existingTasks.some((task) => task.status === "running" || task.status === "pending");
    if (!hasInFlight && existingTasks.length === 0 && prepare) {
      try {
        prepare();
      } catch (err) {
        const failure = err instanceof Error ? err.message : String(err);
        this.ensureBatchTasks(descriptor);
        const firstTask = this.listBatchTasks(descriptor)[0];
        if (firstTask) {
          this.failTask(firstTask, `Failed to prepare verification worktree: ${failure}`);
          this.supersedePendingSiblings(descriptor, firstTask.id, "verification aborted after worktree preparation failure");
          const outcome = this.finalizeBatch(descriptor);
          return outcome ? this.toRequestResult(outcome) : {
            status: "failed",
            artifact: null,
            tasks: this.listBatchTasks(descriptor),
            results: [],
            reason: failure,
          };
        }
        return {
          status: "failed",
          artifact: null,
          tasks: [],
          results: [],
          reason: failure,
        };
      }
    }

    existingTasks = this.listBatchTasks(descriptor);
    if (existingTasks.length > 0) {
      const settled = this.reconcileBatch(descriptor);
      if (settled) {
        return this.toRequestResult(settled);
      }

      const current = this.currentBatchState(descriptor);
      if (current.status !== "scheduled") {
        return current;
      }
    }

    this.ensureBatchTasks(descriptor);
    const outcome = this.reconcileBatch(descriptor);
    if (outcome) {
      return this.toRequestResult(outcome);
    }

    return this.currentBatchState(descriptor);
  }

  private toRequestResult(outcome: VerificationBatchOutcome): VerificationRequestResult {
    return {
      status: outcome.blocked ? "blocked" : outcome.passed ? "passed" : "failed",
      artifact: outcome.artifact,
      tasks: outcome.tasks,
      results: outcome.results,
    };
  }

  private currentBatchState(descriptor: VerifyBatchDescriptor): VerificationRequestResult {
    const tasks = this.listBatchTasks(descriptor);
    const artifact = this.batchArtifact(tasks);
    const report = artifact ? loadArtifactJson<VerifyReportArtifact>(artifact, this.projectRoot) : null;

    if (tasks.some((task) => task.status === "running")) {
      return { status: "running", artifact, tasks, results: report?.results ?? [] };
    }
    if (tasks.some((task) => task.status === "blocked")) {
      return {
        status: "blocked",
        artifact,
        tasks,
        results: report?.results ?? [],
        reason: tasks.find((task) => task.status === "blocked")?.summary ?? undefined,
      };
    }
    if (tasks.some((task) => task.status === "failed")) {
      return {
        status: "failed",
        artifact,
        tasks,
        results: report?.results ?? [],
        reason: tasks.find((task) => task.status === "failed")?.summary ?? undefined,
      };
    }
    if (tasks.every((task) => task.status === "completed") && artifact) {
      return { status: "passed", artifact, tasks, results: report?.results ?? [] };
    }
    return { status: "scheduled", artifact, tasks, results: [] };
  }

  private batchArtifact(tasks: ExecutionTaskRow[]): ArtifactRow | null {
    const resultPath = tasks.find((task) => task.result_path)?.result_path;
    if (!resultPath) return null;
    const run = tasks[0] ? this.db.runs.get(tasks[0].run_id) : null;
    if (!run) return null;
    return this.db.artifacts
      .listByRun(run.id, "verify-report")
      .find((artifact) => artifact.path === resultPath) ?? null;
  }

  private reconcileBatch(descriptor: VerifyBatchDescriptor): VerificationBatchOutcome | null {
    let tasks = this.listBatchTasks(descriptor);
    if (tasks.length === 0) return null;

    for (const task of tasks.filter((item) => item.status === "running")) {
      this.pollRunningTask(task);
    }

    tasks = this.listBatchTasks(descriptor);
    if (tasks.some((task) => task.status === "running")) {
      return null;
    }

    const blocked = tasks.find((task) => task.status === "blocked");
    if (blocked) {
      this.supersedePendingSiblings(descriptor, blocked.id, blocked.summary ?? "verification blocked");
      return this.finalizeBatch(descriptor);
    }

    const failed = tasks.find((task) => task.status === "failed");
    if (failed) {
      this.supersedePendingSiblings(descriptor, failed.id, failed.summary ?? "verification failed");
      return this.finalizeBatch(descriptor);
    }

    const next = tasks.find((task) => task.status === "pending");
    if (next) {
      this.startTask(next);
      tasks = this.listBatchTasks(descriptor);
      for (const task of tasks.filter((item) => item.status === "running")) {
        this.pollRunningTask(task);
      }
      tasks = this.listBatchTasks(descriptor);
      if (tasks.some((task) => task.status === "running")) {
        return null;
      }
      if (tasks.some((task) => task.status === "blocked" || task.status === "failed")) {
        return this.reconcileBatch(descriptor);
      }
    }

    if (tasks.length > 0 && tasks.every((task) => task.status === "completed")) {
      return this.finalizeBatch(descriptor);
    }

    return null;
  }

  private pollRunningTask(task: ExecutionTaskRow): void {
    const outputPath = ensureExecutionTaskOutput(this.db, task.id, this.projectRoot);
    const outputSize = projectFileSize(task.output_path, this.projectRoot);
    const now = isoNow(this.runtime);
    if (outputSize > task.output_size) {
      this.db.executionTasks.update(task.id, {
        output_size: outputSize,
        last_output_at: now,
      });
      task = this.db.executionTasks.get(task.id) ?? task;
    }

    const exitPath = this.taskExitPath(task);
    const exitCode = this.readExitCode(exitPath);
    if (exitCode !== null) {
      try {
        unlinkSync(exitPath);
      } catch {
        // Best-effort cleanup only.
      }
      const outputTail = readProjectFileTail(task.output_path, this.projectRoot, VERIFY_RESULT_TAIL_BYTES);
      const passed = exitCode === 0;
      this.db.executionTasks.update(task.id, {
        status: passed ? "completed" : "failed",
        process_id: null,
        exit_code: exitCode,
        output_size: outputSize,
        last_output_at: outputSize > task.output_size ? now : task.last_output_at,
        summary: passed
          ? `Verify passed: ${task.command}`
          : `Verify failed: ${task.command}`,
        last_error: passed ? null : summarizeFailure(task.command ?? task.logical_name, exitCode, outputTail),
      });
      appendExecutionTaskOutput(
        this.db,
        task.id,
        `[exit ${exitCode}] ${passed ? "PASS" : "FAIL"} ${task.command}\n`,
        this.projectRoot,
      );
      return;
    }

    if (task.process_id && !this.runtime.isPidAlive(task.process_id)) {
      this.db.executionTasks.update(task.id, {
        status: "failed",
        process_id: null,
        exit_code: 1,
        output_size: outputSize,
        summary: `Verify failed: ${task.command}`,
        last_error: "Verify process exited without reporting a status",
      });
      appendExecutionTaskOutput(
        this.db,
        task.id,
        "[exit unknown] FAIL process exited without reporting a status\n",
        this.projectRoot,
      );
      return;
    }

    const lastOutputAt = task.last_output_at ? Date.parse(task.last_output_at.replace(" ", "T")) : this.runtime.nowMs();
    if (this.runtime.nowMs() - lastOutputAt < VERIFY_STALL_THRESHOLD_MS) {
      return;
    }

    const tail = readProjectFileTail(task.output_path, this.projectRoot, 1_024);
    if (!looksInteractivePrompt(tail)) {
      return;
    }

    if (task.process_id) {
      this.runtime.kill(task.process_id);
    }
    this.db.executionTasks.update(task.id, {
      status: "blocked",
      process_id: null,
      output_size: outputSize,
      summary: `Blocked waiting for interactive input: ${task.command}`,
      last_error: "interactive_input",
    });
    appendExecutionTaskOutput(
      this.db,
      task.id,
      "[blocked] command appears to be waiting for interactive input\n",
      this.projectRoot,
    );
  }

  private startTask(task: ExecutionTaskRow): void {
    if (!task.command || !task.cwd) {
      this.failTask(task, "Verification task is missing command or working directory");
      return;
    }

    resetExecutionTaskNotification(this.db, task.id, this.projectRoot);
    ensureExecutionTaskOutput(this.db, task.id, this.projectRoot);
    appendExecutionTaskOutput(
      this.db,
      task.id,
      `\n$ ${task.command}\n`,
      this.projectRoot,
    );

    const outputPath = resolveProjectPath(task.output_path ?? executionTaskOutputRelativePath(this.runFeature(task.run_id), task.run_id, task.id), this.projectRoot);
    const exitPath = this.taskExitPath(task);
    try {
      if (existsSync(exitPath)) {
        unlinkSync(exitPath);
      }
    } catch {
      // Best effort cleanup only.
    }

    try {
      const pid = this.runtime.spawn(task.command, task.cwd, outputPath, exitPath);
      this.db.executionTasks.update(task.id, {
        status: "running",
        process_id: pid,
        exit_code: null,
        output_size: projectFileSize(task.output_path, this.projectRoot),
        last_output_at: isoNow(this.runtime),
        summary: `Running verify command: ${task.command}`,
        result_path: null,
        last_error: null,
      });
    } catch (err) {
      this.failTask(task, err instanceof Error ? err.message : String(err));
    }
  }

  private failTask(task: ExecutionTaskRow, error: string): void {
    resetExecutionTaskNotification(this.db, task.id, this.projectRoot);
    appendExecutionTaskOutput(this.db, task.id, `${error}\n`, this.projectRoot);
    this.db.executionTasks.update(task.id, {
      status: "failed",
      process_id: null,
      exit_code: 1,
      output_size: projectFileSize(task.output_path, this.projectRoot),
      last_output_at: isoNow(this.runtime),
      summary: `Verify failed: ${task.command ?? task.logical_name}`,
      last_error: error,
    });
  }

  private finalizeBatch(descriptor: VerifyBatchDescriptor): VerificationBatchOutcome | null {
    const tasks = this.listBatchTasks(descriptor);
    if (tasks.length === 0) return null;
    if (tasks.some((task) => task.status === "running" || task.status === "pending")) {
      return null;
    }

    const relevantTasks = tasks.filter((task) => task.status !== "superseded");
    const results = relevantTasks.map((task) => this.commandResultForTask(task));
    const blocked = relevantTasks.some((task) => task.status === "blocked");
    const passed = relevantTasks.every((task) => task.status === "completed");
    const safeKey = safeVerifyKey(descriptor.targetKey);
    const nonce = Date.now();
    const artifact = persistJsonArtifact({
      db: this.db,
      artifactId: `art-verify-${safeKey}-${nonce}`,
      runId: descriptor.runId,
      feature: descriptor.feature,
      type: "verify-report",
      filename: `verify-report-${safeKey}-${nonce}.json`,
      data: {
        runId: descriptor.runId,
        feature: descriptor.feature,
        mode: descriptor.mode,
        issueId: descriptor.issueId,
        scopeId: descriptor.scopeId,
        scopeHash: descriptor.scopeHash,
        canonicalBranch: descriptor.canonicalBranch,
        branch: descriptor.branch,
        branches: descriptor.branches,
        worktreePath: descriptor.cwd,
        passed,
        results,
        verifiedAt: new Date(this.runtime.nowMs()).toISOString(),
      } satisfies VerifyReportArtifact,
      projectRoot: this.projectRoot,
      issueId: descriptor.issueId ?? null,
      reviewScopeId: descriptor.scopeId ?? null,
    });

    for (const task of tasks) {
      this.db.executionTasks.update(task.id, {
        result_path: artifact.path,
      });
    }

    if (descriptor.mode === "review_scope" && descriptor.scopeId) {
      this.cleanupReviewScopeWorktree(descriptor.feature, descriptor.scopeId);
    }

    return {
      mode: descriptor.mode,
      runId: descriptor.runId,
      feature: descriptor.feature,
      issueId: descriptor.issueId,
      scopeId: descriptor.scopeId,
      parentTaskId: descriptor.parentTaskId,
      artifact,
      tasks: this.listBatchTasks(descriptor),
      results,
      passed,
      blocked,
    };
  }

  private commandResultForTask(task: ExecutionTaskRow): VerifyCommandResult {
    const outputTail = readProjectFileTail(task.output_path, this.projectRoot, VERIFY_RESULT_TAIL_BYTES) ?? "";
    return {
      command: task.command ?? task.logical_name,
      passed: task.status === "completed",
      exitCode: task.exit_code ?? (task.status === "completed" ? 0 : 1),
      stdout: outputTail,
      stderr: "",
      outputPath: task.output_path ?? undefined,
    };
  }

  private ensureBatchTasks(descriptor: VerifyBatchDescriptor): void {
    const desiredIds = new Set<string>();
    descriptor.commands.forEach((command, index) => {
      const task = this.ensureVerifyExecutionTask({
        runId: descriptor.runId,
        targetKey: descriptor.targetKey,
        issueId: descriptor.issueId,
        reviewScopeId: descriptor.scopeId,
        parentTaskId: descriptor.parentTaskId,
        command,
        cwd: descriptor.cwd,
        index,
      });
      desiredIds.add(task.id);
    });

    for (const task of this.listBatchTasks(descriptor)) {
      if (desiredIds.has(task.id)) continue;
      if (task.status === "superseded") continue;
      supersedeExecutionTask(
        this.db,
        task.id,
        "Removed from verification batch",
        this.projectRoot,
      );
    }
  }

  private ensureVerifyExecutionTask(opts: {
    runId: string;
    targetKey: string;
    issueId?: string;
    reviewScopeId?: string;
    parentTaskId?: string;
    command: string;
    cwd: string;
    index: number;
  }): ExecutionTaskRow {
    const logicalName = buildVerifyExecutionTaskLogicalName(opts.targetKey, opts.index);
    const existing = this.db.executionTasks.getByLogicalName(opts.runId, logicalName);
    if (existing) {
      this.db.executionTasks.update(existing.id, {
        status: existing.status === "running" ? "running" : "pending",
        active_session_id: null,
        review_scope_id: opts.reviewScopeId ?? existing.review_scope_id,
        issue_id: opts.issueId ?? existing.issue_id,
        parent_task_id: opts.parentTaskId ?? existing.parent_task_id,
        command: opts.command,
        cwd: opts.cwd,
        process_id: existing.status === "running" ? existing.process_id : null,
        exit_code: null,
        output_size: existing.status === "running" ? existing.output_size : 0,
        last_output_at: existing.status === "running" ? existing.last_output_at : null,
        summary: existing.status === "running"
          ? existing.summary
          : `Ready to verify: ${opts.command}`,
        result_path: null,
        output_offset: 0,
        notified: 0,
        notified_at: null,
        last_error: null,
      });
      return this.db.executionTasks.get(existing.id)!;
    }

    const id = taskIdFor(opts.targetKey, opts.index);
    this.db.executionTasks.create({
      id,
      run_id: opts.runId,
      issue_id: opts.issueId ?? null,
      review_scope_id: opts.reviewScopeId ?? null,
      parent_task_id: opts.parentTaskId ?? null,
      logical_name: logicalName,
      kind: "verify",
      capability: "shell",
      executor: "shell",
      status: "pending",
      active_session_id: null,
      summary: `Ready to verify: ${opts.command}`,
      output_path: null,
      result_path: null,
      command: opts.command,
      cwd: opts.cwd,
      process_id: null,
      exit_code: null,
      output_size: 0,
      last_output_at: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    return this.db.executionTasks.get(id)!;
  }

  private taskExitPath(task: ExecutionTaskRow): string {
    const outputRelative = task.output_path ?? executionTaskOutputRelativePath(this.runFeature(task.run_id), task.run_id, task.id);
    return resolveProjectPath(`${outputRelative}.exit`, this.projectRoot);
  }

  private readExitCode(path: string): number | null {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const code = Number.parseInt(raw, 10);
    return Number.isNaN(code) ? null : code;
  }

  private latestScopeArtifact(
    runId: string,
    scopeId: string,
    scopeHash: string,
    mode: "canonical" | "review_scope",
  ): ArtifactRow | null {
    const artifacts = this.db.artifacts
      .listByRun(runId, "verify-report")
      .filter((artifact) => artifact.review_scope_id === scopeId);

    for (let i = artifacts.length - 1; i >= 0; i -= 1) {
      const report = loadArtifactJson<VerifyReportArtifact>(artifacts[i], this.projectRoot);
      if (report?.mode === mode && report.scopeHash === scopeHash) {
        return artifacts[i];
      }
    }
    return null;
  }

  private descriptorFromTask(task: ExecutionTaskRow): VerifyBatchDescriptor {
    const run = this.db.runs.get(task.run_id);
    if (!run) {
      throw new Error(`Run ${task.run_id} not found for verification task ${task.id}`);
    }

    const mode = resolveMode(task);
    const scope = task.review_scope_id ? this.db.reviewScopes.get(task.review_scope_id) : null;
    const branch = task.issue_id
      ? this.db.sessions
        .list({ run_id: task.run_id })
        .filter((session) => session.task_id === task.issue_id && !!session.branch)
        .map((session) => session.branch!)
        .at(-1)
      : undefined;

    return {
      mode,
      runId: task.run_id,
      feature: run.feature,
      targetKey: mode === "canonical" && task.review_scope_id
        ? canonicalVerifyTargetKey(task.review_scope_id)
        : task.issue_id ?? task.review_scope_id ?? task.id,
      commands: this.listBatchTasks({
        mode,
        runId: task.run_id,
        feature: run.feature,
        targetKey: task.issue_id ?? task.review_scope_id ?? task.id,
        commands: [],
        cwd: task.cwd ?? this.projectRoot,
        issueId: task.issue_id ?? undefined,
        scopeId: task.review_scope_id ?? undefined,
        parentTaskId: task.parent_task_id ?? undefined,
      }).map((item) => item.command ?? item.logical_name),
      cwd: task.cwd ?? this.projectRoot,
      issueId: task.issue_id ?? undefined,
      scopeId: task.review_scope_id ?? undefined,
      parentTaskId: task.parent_task_id ?? undefined,
      scopeHash: scope?.scope_hash,
      branches: scope ? JSON.parse(scope.branches) as string[] : undefined,
      branch,
    };
  }

  private batchKey(descriptor: VerifyBatchDescriptor): string {
    return [
      descriptor.runId,
      descriptor.mode,
      descriptor.issueId ?? "",
      descriptor.scopeId ?? "",
      descriptor.parentTaskId ?? "",
    ].join(":");
  }

  private listBatchTasks(descriptor: VerifyBatchDescriptor): ExecutionTaskRow[] {
    return this.db.executionTasks
      .list({ run_id: descriptor.runId, kind: "verify" })
      .filter((task) => {
        if (descriptor.mode === "issue") {
          return task.issue_id === descriptor.issueId && task.parent_task_id === (descriptor.parentTaskId ?? null);
        }
        if (descriptor.mode === "review_scope") {
          return task.review_scope_id === descriptor.scopeId && task.parent_task_id === (descriptor.parentTaskId ?? null);
        }
        return task.review_scope_id === descriptor.scopeId && task.parent_task_id === null && task.issue_id === null;
      })
      .sort((a, b) => a.logical_name.localeCompare(b.logical_name));
  }

  private supersedePendingSiblings(descriptor: VerifyBatchDescriptor, keepTaskId: string, reason: string): void {
    for (const task of this.listBatchTasks(descriptor)) {
      if (task.id === keepTaskId) continue;
      if (task.status !== "pending") continue;
      supersedeExecutionTask(this.db, task.id, reason, this.projectRoot);
    }
  }

  private runFeature(runId: string): string {
    const run = this.db.runs.get(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return run.feature;
  }

  private reviewScopeWorktreeName(scopeId: string): string {
    return reviewScopeVerifierName(scopeId);
  }

  private reviewScopeWorktreePath(scopeId: string): string {
    return worktree.worktreePath(this.reviewScopeWorktreeName(scopeId), this.projectRoot);
  }

  private prepareReviewScopeWorktree(descriptor: VerifyBatchDescriptor): void {
    if (!descriptor.scopeId || !descriptor.canonicalBranch) {
      throw new Error("Review-scope verification requires a scope and canonical branch");
    }

    const prepared = worktree.create(
      this.reviewScopeWorktreeName(descriptor.scopeId),
      descriptor.feature,
      descriptor.canonicalBranch,
      this.projectRoot,
      this.worktreeOptions,
    );
    if (!prepared.existed && (descriptor.branches ?? []).length > 0) {
      worktree.seedFromBranches(prepared.path, descriptor.branches ?? []);
    }
  }

  private cleanupReviewScopeWorktree(feature: string, scopeId: string): void {
    cleanupReviewScopeVerifierWorktree(feature, scopeId, this.projectRoot);
  }
}

export function requestCanonicalVerification(opts: {
  db: CnogDB;
  runId: string;
  feature: string;
  scopeId: string;
  scopeHash: string;
  canonicalBranch: string;
  commands: string[];
  projectRoot?: string;
  worktreeOptions?: worktree.WorktreeOptions;
}): VerificationRequestResult {
  return new VerifyManager(opts.db, {
    projectRoot: opts.projectRoot,
    worktreeOptions: opts.worktreeOptions,
  }).requestCanonicalVerification({
    runId: opts.runId,
    feature: opts.feature,
    scopeId: opts.scopeId,
    scopeHash: opts.scopeHash,
    canonicalBranch: opts.canonicalBranch,
    commands: opts.commands,
  });
}

export function requestIssueVerification(opts: {
  db: CnogDB;
  runId: string;
  feature: string;
  issueId: string;
  parentTaskId?: string;
  branch: string;
  worktreePath: string;
  commands: string[];
  projectRoot?: string;
  worktreeOptions?: worktree.WorktreeOptions;
}): VerificationRequestResult {
  return new VerifyManager(opts.db, {
    projectRoot: opts.projectRoot,
    worktreeOptions: opts.worktreeOptions,
  }).requestIssueVerification({
    runId: opts.runId,
    feature: opts.feature,
    issueId: opts.issueId,
    parentTaskId: opts.parentTaskId,
    branch: opts.branch,
    worktreePath: opts.worktreePath,
    commands: opts.commands,
  });
}

export function requestReviewScopeVerification(opts: {
  db: CnogDB;
  runId: string;
  feature: string;
  scopeId: string;
  parentTaskId?: string;
  scopeHash: string;
  canonicalBranch: string;
  branches: string[];
  commands: string[];
  projectRoot?: string;
  worktreeOptions?: worktree.WorktreeOptions;
}): VerificationRequestResult {
  return new VerifyManager(opts.db, {
    projectRoot: opts.projectRoot,
    worktreeOptions: opts.worktreeOptions,
  }).requestReviewScopeVerification({
    runId: opts.runId,
    feature: opts.feature,
    scopeId: opts.scopeId,
    parentTaskId: opts.parentTaskId,
    scopeHash: opts.scopeHash,
    canonicalBranch: opts.canonicalBranch,
    branches: opts.branches,
    commands: opts.commands,
  });
}

export function reconcileVerificationTasks(opts: {
  db: CnogDB;
  projectRoot?: string;
  runId?: string;
}): VerificationBatchOutcome[] {
  return new VerifyManager(opts.db, { projectRoot: opts.projectRoot }).reconcile(opts.runId);
}
