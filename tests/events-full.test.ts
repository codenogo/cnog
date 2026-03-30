/**
 * Full coverage for EventEmitter — tests all convenience methods.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";

let db: CnogDB;
let emitter: EventEmitter;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-events-full-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  emitter = new EventEmitter(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("EventEmitter — all methods", () => {
  it("agentStopped logs with reason", () => {
    emitter.agentStopped("builder-1", "user requested");
    const rows = db.events.query({ agent: "builder-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("agent_stopped");
    expect(rows[0].message).toContain("user requested");
  });

  it("agentNudged logs at warn level", () => {
    emitter.agentNudged("builder-1");
    const rows = db.events.query({ level: "warn" });
    expect(rows.some((r) => r.event_type === "agent_nudged")).toBe(true);
  });

  it("mergeCompleted logs tier", () => {
    emitter.mergeCompleted("cnog/auth/b1", "clean");
    const rows = db.events.query({ source: "merge" });
    expect(rows[0].event_type).toBe("merge_completed");
    expect(rows[0].message).toContain("clean");
  });

  it("mergeConflict logs at warn with file list", () => {
    emitter.mergeConflict("branch", ["a.ts", "b.ts"]);
    const rows = db.events.query({ level: "warn" });
    expect(rows[0].event_type).toBe("merge_conflict");
    expect(rows[0].message).toContain("a.ts");
  });

  it("mailReceived logs mail event", () => {
    emitter.mailReceived("builder-1", "orchestrator", "status");
    const rows = db.events.query({ source: "mail" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("mail_received");
  });

  it("orchestratorStarted and Stopped log lifecycle", () => {
    emitter.orchestratorStarted();
    emitter.orchestratorStopped();
    const rows = db.events.query({ source: "orchestrator" });
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.event_type);
    expect(types).toContain("orchestrator_started");
    expect(types).toContain("orchestrator_stopped");
  });

  it("taskDispatched logs dispatch event", () => {
    emitter.taskDispatched("builder-1", "Add models", "auth", "cn-abc");
    const rows = db.events.query({ source: "dispatch" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("task_dispatched");
    expect(rows[0].feature).toBe("auth");
  });
});
