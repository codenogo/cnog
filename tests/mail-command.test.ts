import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { CnogDB } from "../src/db.js";
import { mailSendCommand } from "../src/commands/mail.js";
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

describe.sequential("mailSendCommand", () => {
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
    db.sessions.create({
      id: "session-1",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: "cn-123",
      worktree_path: tmpDir,
      branch: "cnog/auth/builder-auth",
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: runId,
    });

    process.chdir(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("infers the current agent and merge payload from the worktree branch", () => {
    mailSendCommand("orchestrator", "done", {
      body: "",
      type: "worker_done",
      priority: "high",
    });

    const messages = db.messages.checkMail("orchestrator");
    expect(messages).toHaveLength(1);
    expect(messages[0].from_agent).toBe("builder-auth");
    expect(JSON.parse(messages[0].payload ?? "{}")).toMatchObject({
      feature: "auth",
      branch: "cnog/auth/builder-auth",
    });
  });
});
