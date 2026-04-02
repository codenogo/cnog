/**
 * Additional mail tests for untested methods.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { MailClient } from "../src/mail.js";

let db: CnogDB;
let mail: MailClient;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-mail-full-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  db.runs.create({
    id: "run-auth-1",
    feature: "auth",
    plan_number: null,
    status: "build",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
  mail = new MailClient(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MailClient — missing methods", () => {
  it("readAll marks all messages as read", () => {
    mail.send({ fromAgent: "a", toAgent: "b", subject: "msg1" });
    mail.send({ fromAgent: "c", toAgent: "b", subject: "msg2" });
    mail.send({ fromAgent: "d", toAgent: "b", subject: "msg3" });

    expect(mail.check("b")).toHaveLength(3);

    mail.readAll("b");
    expect(mail.check("b")).toHaveLength(0);
  });

  it("readAll only affects the specified agent", () => {
    mail.send({ fromAgent: "a", toAgent: "b", subject: "msg1" });
    mail.send({ fromAgent: "a", toAgent: "c", subject: "msg2" });

    mail.readAll("b");
    expect(mail.check("b")).toHaveLength(0);
    expect(mail.check("c")).toHaveLength(1);
  });

  it("notifyWorkerNotification sends high-priority worker_notification", () => {
    mail.notifyWorkerNotification("builder-1", {
      protocolVersion: 2,
      kind: "worker_notification",
      status: "completed",
      summary: "Merged build work",
      run: { id: "run-auth-1", feature: "auth" },
      actor: {
        agentName: "builder-1",
        logicalName: "builder-1",
        attempt: 1,
        capability: "builder",
        runtime: "claude",
        sessionId: "session-builder-1",
      },
      task: {
        executionTaskId: "xtask-auth-1",
        kind: "build",
        executor: "agent",
        issueId: "cn-auth-1",
      },
      output: {
        taskLogPath: ".cnog/features/auth/runs/run-auth-1/tasks/xtask-auth-1.output",
      },
      worktree: {
        branch: "cnog/auth/builder-1",
        headSha: "abc123",
      },
      data: {
        kind: "builder_completion",
        headSha: "abc123",
        filesModified: ["src/auth.ts"],
      },
    });

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("worker_notification");
    expect(msgs[0].priority).toBe("high");
    expect(msgs[0].payload).toBeDefined();
    expect((msgs[0].payload as { worktree?: { branch?: string } }).worktree?.branch).toBe("cnog/auth/builder-1");
    expect((msgs[0].payload as { run?: { feature?: string } }).run?.feature).toBe("auth");
  });
});
