import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { CnogDB } from "../src/db.js";
import { reportBuilderCompleteCommand } from "../src/commands/mail.js";
import { CNOG_DIR, DB_PATH } from "../src/paths.js";

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

describe.sequential("reportBuilderCompleteCommand", () => {
  let tmpDir: string;
  let originalCwd: string;
  let db: CnogDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-mail-command-test-"));
    originalCwd = process.cwd();

    git(tmpDir, "init", "-b", "main");
    git(tmpDir, "config", "user.email", "test@example.com");
    git(tmpDir, "config", "user.name", "Test User");

    writeFileSync(join(tmpDir, "README.md"), "# test\n", "utf-8");
    git(tmpDir, "add", "README.md");
    git(tmpDir, "commit", "-m", "init");
    git(tmpDir, "checkout", "-b", "cnog/auth/builder-auth");

    mkdirSync(join(tmpDir, CNOG_DIR), { recursive: true });
    db = new CnogDB(join(tmpDir, DB_PATH));
    const runId = "run-mail-cmd-1";
    db.runs.create({
      id: runId, feature: "auth", plan_number: null, status: "plan", phase_reason: null,
      profile: null, tasks: null, review: null, ship: null, worktree_path: null,
    });
    db.issues.create({
      id: "cn-123",
      title: "Implement auth task",
      description: null,
      issue_type: "task",
      status: "open",
      priority: 1,
      assignee: null,
      feature: "auth",
      run_id: runId,
      plan_number: null,
      phase: null,
      parent_id: null,
      metadata: null,
    });
    db.executionTasks.create({
      id: "xtask-auth-1",
      run_id: runId,
      issue_id: "cn-123",
      review_scope_id: null,
      parent_task_id: null,
      logical_name: "build:cn-123",
      kind: "build",
      capability: "builder",
      executor: "agent",
      status: "running",
      active_session_id: null,
      summary: "Running build",
      output_path: ".cnog/features/auth/runs/run-mail-cmd-1/tasks/xtask-auth-1.output",
      result_path: null,
      output_offset: 0,
      notified: 0,
      notified_at: null,
      last_error: null,
    });
    db.sessions.create({
      id: "session-1",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: "cn-123",
      execution_task_id: "xtask-auth-1",
      worktree_path: tmpDir,
      transcript_path: null,
      branch: "cnog/auth/builder-auth",
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });
    db.executionTasks.update("xtask-auth-1", { active_session_id: "session-1" });

    process.chdir(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("infers the current agent from the worktree branch and enriches the notification envelope", () => {
    reportBuilderCompleteCommand({
      summary: "Implemented auth task",
    });

    const messages = db.messages.checkMail("orchestrator");
    expect(messages).toHaveLength(1);
    expect(messages[0].from_agent).toBe("builder-auth");
    const payload = JSON.parse(messages[0].payload ?? "{}");
    expect(messages[0].type).toBe("worker_notification");
    expect(payload).toMatchObject({
      protocolVersion: 2,
      kind: "worker_notification",
      status: "completed",
      summary: "Implemented auth task",
      run: {
        id: "run-mail-cmd-1",
        feature: "auth",
      },
      actor: {
        agentName: "builder-auth",
        logicalName: "builder-auth",
        capability: "builder",
      },
      task: {
        executionTaskId: "xtask-auth-1",
        issueId: "cn-123",
      },
      worktree: {
        branch: "cnog/auth/builder-auth",
      },
      data: {
        kind: "builder_completion",
      },
    });
    expect(payload.usage.durationMs).toBeTypeOf("number");
    expect(payload.worktree.headSha).toBeTruthy();
  });
});
