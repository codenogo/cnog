import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";

let db: CnogDB;
let events: EventEmitter;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-events-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("EventEmitter", () => {
  it("emits a generic event", () => {
    events.emit({
      source: "test",
      eventType: "test_event",
      message: "hello world",
    });

    const rows = db.events.query({ source: "test" });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("hello world");
    expect(rows[0].level).toBe("info");
  });

  it("agentSpawned logs with correct fields", () => {
    events.agentSpawned("builder-1", "builder", "auth", "cnog/auth/builder-1");

    const rows = db.events.query({ agent: "builder-1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("agent_spawned");
    expect(rows[0].source).toBe("agents");
    expect(rows[0].feature).toBe("auth");
  });

  it("agentFailed logs at error level", () => {
    events.agentFailed("agent-1", "process died");

    const rows = db.events.query({ level: "error" });
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_name).toBe("agent-1");
  });

  it("mergeEnqueued logs merge event", () => {
    events.mergeEnqueued("cnog/auth/builder", "auth", "builder");

    const rows = db.events.query({ source: "merge" });
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe("merge_enqueued");
  });

  it("escalation logs at warn level", () => {
    events.escalation("builder-1", "blocked", "need help");

    const rows = db.events.query({ level: "warn" });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("builder-1");
  });

  it("phaseAdvanced logs lifecycle transition", () => {
    events.phaseAdvanced("auth", "plan", "implement");

    const rows = db.events.query({ source: "lifecycle" });
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toContain("plan");
    expect(rows[0].message).toContain("implement");
  });
});
