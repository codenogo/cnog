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

  it("notifyMergeReady sends high-priority merge_ready", () => {
    mail.notifyMergeReady("builder-1", "auth", "cnog/auth/builder-1");

    const msgs = mail.check("orchestrator");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe("merge_ready");
    expect(msgs[0].priority).toBe("high");
    expect(msgs[0].payload).toBeDefined();
    expect(msgs[0].payload!.branch).toBe("cnog/auth/builder-1");
    expect(msgs[0].payload!.feature).toBe("auth");
  });
});
