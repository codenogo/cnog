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
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-mail-test-"));
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

describe("MailClient", () => {
  it("sends and checks messages", () => {
    mail.send({
      fromAgent: "builder-1",
      toAgent: "orchestrator",
      subject: "done",
      type: "worker_notification",
      payload: {
        protocolVersion: 2,
        kind: "worker_notification",
        status: "completed",
        summary: "Implemented auth flow",
        run: { id: "run-auth-1", feature: "auth" },
        actor: {
          agentName: "builder-1",
          logicalName: "builder-1",
          attempt: 1,
          capability: "builder",
          runtime: "claude",
          sessionId: "session-1",
        },
        task: {
          executionTaskId: "xtask-auth-1",
          kind: "build",
          executor: "agent",
          issueId: "cn-auth-1",
        },
        output: {
          taskLogPath: ".cnog/features/auth/runs/run-auth-1/tasks/xtask-auth-1.output",
          transcriptPath: ".cnog/features/auth/runs/run-auth-1/sessions/builder-1.log",
        },
        worktree: {
          branch: "cnog/auth/builder-1",
          headSha: "abc123",
          filesModified: ["src/auth.ts"],
        },
        usage: {
          durationMs: 1000,
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
        },
        data: {
          kind: "builder_completion",
          headSha: "abc123",
          filesModified: ["src/auth.ts"],
        },
      },
    });

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].fromAgent).toBe("builder-1");
    expect(msgs[0].subject).toBe("done");
    expect(msgs[0].type).toBe("worker_notification");
    expect(msgs[0].read).toBe(false);
  });

  it("marks messages as read", () => {
    mail.send({
      fromAgent: "a",
      toAgent: "b",
      subject: "test",
    });

    const msgs = mail.check("b");
    mail.read(msgs[0].id);

    expect(mail.check("b")).toHaveLength(0);
  });

  it("lists message history", () => {
    mail.send({ fromAgent: "a", toAgent: "b", subject: "msg1" });
    mail.send({ fromAgent: "b", toAgent: "a", subject: "msg2" });

    const list = mail.list("a");
    expect(list).toHaveLength(2);
  });

  it("replies preserving thread", () => {
    mail.send({
      fromAgent: "builder-1",
      toAgent: "orchestrator",
      subject: "help",
      type: "worker_notification",
      payload: {
        protocolVersion: 2,
        kind: "worker_notification",
        status: "blocked",
        summary: "Need shared dependency",
        run: { id: "run-auth-1", feature: "auth" },
        actor: {
          agentName: "builder-1",
          logicalName: "builder-1",
          attempt: 1,
          capability: "builder",
          runtime: "claude",
          sessionId: "session-1",
        },
        task: {},
        output: {},
        data: {
          kind: "escalation",
          role: "builder",
          code: "missing_dependency",
          evidence: ["shared module missing"],
          requestedAction: "Provide dependency branch",
        },
      },
    });

    const msgs = mail.check("orchestrator");
    mail.reply(msgs[0], {
      fromAgent: "orchestrator",
      body: "Try this approach",
    });

    const replies = mail.check("builder-1");
    expect(replies).toHaveLength(1);
    expect(replies[0].subject).toBe("Re: help");
    expect(replies[0].threadId).toBeTruthy();
  });

  it("notifyWorkerNotification sends structured message", () => {
    mail.notifyWorkerNotification("builder-auth", {
      protocolVersion: 2,
      kind: "worker_notification",
      status: "completed",
      summary: "Implemented auth flow",
      run: { id: "run-auth-1", feature: "auth" },
      actor: {
        agentName: "builder-auth",
        logicalName: "builder-auth",
        attempt: 1,
        capability: "builder",
        runtime: "claude",
        sessionId: "session-builder-auth",
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
        branch: "cnog/auth/builder-auth",
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
    expect(msgs[0].payload!.kind).toBe("worker_notification");
    expect((msgs[0].payload as { worktree?: { branch?: string } }).worktree?.branch).toBe("cnog/auth/builder-auth");
  });
});
