import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { MailClient } from "../src/mail.js";
import { Watchdog } from "../src/watchdog.js";

let db: CnogDB;
let events: EventEmitter;
let mail: MailClient;
let tmpDir: string;
let testRunId: string;

function createTestRun(db: CnogDB, feature: string = "test-feature"): string {
  const id = `run-wd-${Date.now()}`;
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-watchdog-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  mail = new MailClient(db);
  testRunId = createTestRun(db, "auth");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Watchdog", () => {
  it("inspects active sessions through the pure health policy", () => {
    db.sessions.create({
      id: "s1",
      name: "builder-auth",
      logical_name: "builder-auth",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: "cnog-builder-auth",
      pid: 123,
      state: "working",
      parent_agent: null,
      run_id: testRunId,
    });

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      1_000,
      5_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => new Date("2026-03-26T12:10:00.000Z").getTime(),
      },
    );

    db.db.prepare("UPDATE sessions SET started_at = ? WHERE name = ?").run("2026-03-26 12:00:00", "builder-auth");
    const health = watchdog.inspectActive();

    expect(health).toHaveLength(1);
    expect(health[0].decision.kind).toBe("zombie");
    expect(health[0].decision.action).toBe("kill_tmux");
  });

  it("restores a stalled agent to working once it is healthy again", () => {
    db.sessions.create({
      id: "s2",
      name: "builder-recovered",
      logical_name: "builder-recovered",
      attempt: 1,
      runtime: "claude",
      capability: "builder",
      feature: "auth",
      task_id: null,
      worktree_path: null,
      branch: null,
      tmux_session: "cnog-builder-recovered",
      pid: 123,
      state: "stalled",
      parent_agent: null,
      run_id: testRunId,
    });

    db.db.prepare("UPDATE sessions SET started_at = ?, last_heartbeat = ? WHERE name = ?")
      .run("2026-03-26 12:00:00", "2026-03-26 12:09:59", "builder-recovered");

    const watchdog = new Watchdog(
      db,
      events,
      mail,
      60_000,
      300_000,
      {
        isPidAlive: () => true,
        isSessionAlive: () => true,
        nowMs: () => new Date("2026-03-26T12:10:00.000Z").getTime(),
      },
    );

    watchdog.tick();

    expect(db.sessions.get("builder-recovered")?.state).toBe("working");
    const recovery = db.events.query({ source: "watchdog" }).find((event) => event.event_type === "agent_recovered");
    expect(recovery).toBeDefined();
  });
});
