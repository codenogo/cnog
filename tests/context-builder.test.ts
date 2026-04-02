import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import {
  buildWorkerContextBundle,
  ensureWorkerScratchpadPaths,
  renderContextBundleMarkdown,
} from "../src/context-builder.js";
import { saveCheckpoint } from "../src/checkpoint.js";

describe("context builder", () => {
  let tmpDir: string;
  let db: CnogDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-context-builder-"));
    db = new CnogDB(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds layered context with checkpoint tails and scratchpad paths", () => {
    db.runs.create({
      id: "run-auth-1",
      feature: "auth",
      plan_number: null,
      status: "build",
      phase_reason: "accepted contracts ready",
      profile: "feature-delivery",
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });
    db.issues.create({
      id: "issue-auth-1",
      title: "Implement auth flow",
      description: null,
      issue_type: "task",
      status: "in_progress",
      priority: 1,
      assignee: "builder-auth",
      feature: "auth",
      run_id: "run-auth-1",
      plan_number: null,
      phase: "build",
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-auth-1",
      run_id: "run-auth-1",
      issue_id: "issue-auth-1",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:issue-auth-1",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Implementing auth flow",
      output_path: ".cnog/features/auth/runs/run-auth-1/tasks/xtask-auth-1.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.sessions.create({
      id: "sess-builder-auth",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: "issue-auth-1",
      execution_task_id: "xtask-auth-1",
      worktree_path: join(tmpDir, ".cnog", "worktrees", "builder-auth"),
      transcript_path: ".cnog/features/auth/runs/run-auth-1/sessions/builder-auth.log",
      branch: "cnog/auth/builder-auth",
      tmux_session: "cnog-builder-auth",
      pid: 123,
      state: "working",
      parent_agent: null,
      run_id: "run-auth-1",
    });
    db.executionTasks.update("xtask-auth-1", { active_session_id: "sess-builder-auth" });
    db.sessionProgress.recordActivity({
      sessionId: "sess-builder-auth",
      runId: "run-auth-1",
      executionTaskId: "xtask-auth-1",
      transcriptPath: ".cnog/features/auth/runs/run-auth-1/sessions/builder-auth.log",
      transcriptSize: 64,
      toolName: "Write",
      activityKind: "write",
      summary: "Modified src/auth.ts",
      target: "src/auth.ts",
    });

    const transcriptPath = join(tmpDir, ".cnog", "features", "auth", "runs", "run-auth-1", "sessions");
    const taskPath = join(tmpDir, ".cnog", "features", "auth", "runs", "run-auth-1", "tasks");
    mkdirSync(transcriptPath, { recursive: true });
    mkdirSync(taskPath, { recursive: true });
    writeFileSync(join(transcriptPath, "builder-auth.log"), "thinking...\nupdated auth middleware\n", "utf-8");
    writeFileSync(join(taskPath, "xtask-auth-1.output"), "attempt 1\nedited src/auth.ts\n", "utf-8");

    saveCheckpoint({
      agentName: "builder-auth",
      logicalName: "builder-auth",
      runId: "run-auth-1",
      feature: "auth",
      taskId: "issue-auth-1",
      sessionId: "sess-builder-auth",
      timestamp: new Date().toISOString(),
      progressSummary: "Finished middleware wiring.",
      filesModified: ["src/auth.ts"],
      currentBranch: "cnog/auth/builder-auth",
      pendingWork: "Hook login route into middleware.",
      verifyResults: { "npm test": true },
      resumeContext: {
        transcriptPath: ".cnog/features/auth/runs/run-auth-1/sessions/builder-auth.log",
        taskLogPath: ".cnog/features/auth/runs/run-auth-1/tasks/xtask-auth-1.output",
        transcriptTail: "thinking...\nupdated auth middleware",
        taskLogTail: "attempt 1\nedited src/auth.ts",
        lastActivityAt: "2026-04-01T10:00:00.000Z",
        lastActivitySummary: "Modified src/auth.ts",
        toolUseCount: 1,
        durationMs: 60000,
        inputTokens: 50,
        outputTokens: 75,
        costUsd: 0.0042,
        recentActivities: [
          {
            at: "2026-04-01T10:00:00.000Z",
            kind: "write",
            tool: "Write",
            target: "src/auth.ts",
            summary: "Modified src/auth.ts",
          },
        ],
        scratchpad: {
          shared: join(tmpDir, ".cnog", "scratch", "runs", "run-auth-1", "shared"),
          role: join(tmpDir, ".cnog", "scratch", "runs", "run-auth-1", "builder"),
          agent: join(tmpDir, ".cnog", "scratch", "runs", "run-auth-1", "builder", "builder-auth"),
        },
      },
    }, db, tmpDir);

    const scratchpad = ensureWorkerScratchpadPaths({
      feature: "auth",
      runId: "run-auth-1",
      role: "builder",
      agentName: "builder-auth-r2",
      projectRoot: tmpDir,
    });

    const bundle = buildWorkerContextBundle({
      db,
      projectRoot: tmpDir,
      runId: "run-auth-1",
      feature: "auth",
      role: "builder",
      logicalName: "builder-auth",
      worktreePath: join(tmpDir, ".cnog", "worktrees", "builder-auth-r2"),
      scratchpad,
      assignment: {
        kind: "builder_assignment",
        objective: "Implement auth flow",
        planTaskKey: "auth:01:00",
        taskIndex: 0,
        taskName: "Implement auth flow",
        action: "Wire auth middleware.",
        planGoal: "Ship auth",
        fileScope: ["src/auth.ts"],
        microSteps: [],
        contextLinks: [],
        canonicalVerifyCommands: ["npm test"],
        packageVerifyCommands: [],
      },
      canonicalBranch: "main",
      branch: "cnog/auth/builder-auth-r2",
      issueId: "issue-auth-1",
      dependencyBranches: ["cnog/auth/shared"],
    });

    const markdown = renderContextBundleMarkdown(bundle);
    expect(bundle.layers.map((layer) => layer.title)).toEqual(expect.arrayContaining([
      "Git Snapshot",
      "Run Phase",
      "Dependency Branches",
      "Checkpoint & Resume Context",
      "Run Scratchpad",
    ]));
    expect(markdown).toContain("Transcript Tail");
    expect(markdown).toContain("Task Log Tail");
    expect(markdown).toContain("builder-auth-r2");
    expect(markdown).toContain("accepted contracts ready");
  });
});
