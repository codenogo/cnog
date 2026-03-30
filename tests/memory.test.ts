import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { MemoryEngine } from "../src/memory.js";

let db: CnogDB;
let memory: MemoryEngine;
let tmpDir: string;
let testRunId: string;

function createTestRun(db: CnogDB, feature: string = "test-feature"): string {
  const id = `run-mem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
  return id;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-memory-test-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  memory = new MemoryEngine(db);
  testRunId = createTestRun(db);
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MemoryEngine", () => {
  it("creates an issue with auto-generated ID", () => {
    const issue = memory.create({ title: "Implement auth", runId: testRunId });
    expect(issue.id).toMatch(/^cn-/);
    expect(issue.title).toBe("Implement auth");
    expect(issue.status).toBe("open");
    expect(issue.issueType).toBe("task");
  });

  it("gets an issue by ID", () => {
    const created = memory.create({ title: "Test", runId: testRunId });
    const fetched = memory.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe("Test");
  });

  it("lists issues with filters", () => {
    const authRunId = createTestRun(db, "auth");
    const billingRunId = createTestRun(db, "billing");
    memory.create({ title: "Task 1", feature: "auth", runId: authRunId });
    memory.create({ title: "Task 2", feature: "auth", runId: authRunId });
    memory.create({ title: "Task 3", feature: "billing", runId: billingRunId });

    expect(memory.list({ feature: "auth" })).toHaveLength(2);
    expect(memory.list({ feature: "billing" })).toHaveLength(1);
  });

  it("claims an issue", () => {
    const issue = memory.create({ title: "Claim me", runId: testRunId });
    memory.claim(issue.id, "builder-1");

    const updated = memory.get(issue.id)!;
    expect(updated.status).toBe("in_progress");
    expect(updated.assignee).toBe("builder-1");
  });

  it("marks issue as done", () => {
    const issue = memory.create({ title: "Done me", runId: testRunId });
    memory.done(issue.id);
    expect(memory.get(issue.id)!.status).toBe("done");
  });

  it("closes an issue", () => {
    const issue = memory.create({ title: "Close me", runId: testRunId });
    memory.close(issue.id);
    const closed = memory.get(issue.id)!;
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();
  });

  it("tracks dependencies", () => {
    const authRunId = createTestRun(db, "auth");
    const t1 = memory.create({ title: "Task 1", feature: "auth", runId: authRunId });
    const t2 = memory.create({ title: "Task 2", feature: "auth", runId: authRunId });
    memory.addDep(t2.id, t1.id);

    const issue = memory.get(t2.id)!;
    expect(issue.deps).toContain(t1.id);
  });

  it("ready() returns only unblocked issues", () => {
    const authRunId = createTestRun(db, "auth");
    const t1 = memory.create({ title: "Task 1", feature: "auth", runId: authRunId });
    const t2 = memory.create({ title: "Task 2", feature: "auth", runId: authRunId });
    memory.addDep(t2.id, t1.id);

    // t1 is ready (no deps), t2 is blocked
    const ready = memory.ready("auth");
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe(t1.id);

    // Complete t1, now t2 should be ready
    memory.done(t1.id);
    const ready2 = memory.ready("auth");
    expect(ready2).toHaveLength(1);
    expect(ready2[0].id).toBe(t2.id);
  });

  it("stats() returns correct counts", () => {
    const authRunId = createTestRun(db, "auth");
    memory.create({ title: "Open 1", feature: "auth", runId: authRunId });
    memory.create({ title: "Open 2", feature: "auth", runId: authRunId });
    const t3 = memory.create({ title: "Done 1", feature: "auth", runId: authRunId });
    memory.done(t3.id);

    const stats = memory.stats("auth");
    expect(stats.open).toBe(2);
    expect(stats.done).toBe(1);
  });
});
