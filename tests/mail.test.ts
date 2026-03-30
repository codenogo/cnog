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
      type: "worker_done",
    });

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].fromAgent).toBe("builder-1");
    expect(msgs[0].subject).toBe("done");
    expect(msgs[0].type).toBe("worker_done");
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
      type: "escalation",
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

  it("notifyWorkerDone sends structured message", () => {
    mail.notifyWorkerDone({
      agentName: "builder-auth",
      feature: "auth",
      branch: "cnog/auth/builder-auth",
      filesModified: ["src/auth.ts"],
    });

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("worker_done");
    expect(msgs[0].priority).toBe("high");
    expect(msgs[0].payload).toBeDefined();
    expect(msgs[0].payload!.branch).toBe("cnog/auth/builder-auth");
  });

  it("escalate sends high priority message", () => {
    mail.escalate({
      agentName: "builder-1",
      subject: "blocked on npm",
      body: "Cannot install deps",
    });

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("escalation");
    expect(msgs[0].priority).toBe("high");
  });
});
