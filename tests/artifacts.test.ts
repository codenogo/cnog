import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CnogDB } from "../src/db.js";

let db: CnogDB;
const RUN_ID = "run-art-test";
const FEATURE = "test-feature";

function createRun(id: string = RUN_ID, feature: string = FEATURE) {
  db.runs.create({
    id, feature, plan_number: null, status: "plan", phase_reason: null,
    profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
}

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "cnog-art-"));
  db = new CnogDB(join(tmp, "test.db"));
  createRun();
});

describe("ArtifactStore", () => {
  it("creates and retrieves an artifact", () => {
    db.artifacts.create({
      id: "art-1",
      run_id: RUN_ID,
      feature: FEATURE,
      type: "plan",
      path: ".cnog/features/test/runs/run-art-test/plan.json",
      hash: "abc123",
      issue_id: null,
      session_id: null,
      review_scope_id: null,
    });

    const art = db.artifacts.get("art-1");
    expect(art).toBeDefined();
    expect(art!.run_id).toBe(RUN_ID);
    expect(art!.feature).toBe(FEATURE);
    expect(art!.type).toBe("plan");
    expect(art!.hash).toBe("abc123");
  });

  it("lists artifacts by run", () => {
    db.artifacts.create({
      id: "art-plan", run_id: RUN_ID, feature: FEATURE, type: "plan",
      path: "p1.json", hash: "h1", issue_id: null, session_id: null, review_scope_id: null,
    });
    db.artifacts.create({
      id: "art-contract", run_id: RUN_ID, feature: FEATURE, type: "contract",
      path: "c1.json", hash: "h2", issue_id: null, session_id: null, review_scope_id: null,
    });

    const all = db.artifacts.listByRun(RUN_ID);
    expect(all).toHaveLength(2);

    const plans = db.artifacts.listByRun(RUN_ID, "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe("art-plan");
  });

  it("lists artifacts by feature", () => {
    db.artifacts.create({
      id: "art-f1", run_id: RUN_ID, feature: FEATURE, type: "contract",
      path: "c.json", hash: "h", issue_id: null, session_id: null, review_scope_id: null,
    });

    const list = db.artifacts.listByFeature(FEATURE);
    expect(list).toHaveLength(1);
  });

  it("lists artifacts by issue", () => {
    db.issues.create({
      id: "cn-12345678", title: "test issue", description: null, issue_type: "task",
      status: "open", priority: 1, assignee: null, feature: FEATURE, run_id: RUN_ID,
      plan_number: null, phase: null, parent_id: null, metadata: null,
    });
    db.artifacts.create({
      id: "art-i1", run_id: RUN_ID, feature: FEATURE, type: "contract",
      path: "c.json", hash: "h", issue_id: "cn-12345678", session_id: null, review_scope_id: null,
    });

    const list = db.artifacts.listByIssue("cn-12345678");
    expect(list).toHaveLength(1);
  });

  it("enforces immutability — inserting same ID fails", () => {
    db.artifacts.create({
      id: "art-dup", run_id: RUN_ID, feature: FEATURE, type: "plan",
      path: "p.json", hash: "h1", issue_id: null, session_id: null, review_scope_id: null,
    });

    expect(() => db.artifacts.create({
      id: "art-dup", run_id: RUN_ID, feature: FEATURE, type: "plan",
      path: "p2.json", hash: "h2", issue_id: null, session_id: null, review_scope_id: null,
    })).toThrow();
  });

  it("enforces artifact type CHECK constraint", () => {
    expect(() => db.artifacts.create({
      id: "art-bad", run_id: RUN_ID, feature: FEATURE, type: "invalid-type" as any,
      path: "p.json", hash: "h", issue_id: null, session_id: null, review_scope_id: null,
    })).toThrow();
  });

  it("enforces run_id FK constraint", () => {
    expect(() => db.artifacts.create({
      id: "art-no-run", run_id: "nonexistent-run", feature: FEATURE, type: "plan",
      path: "p.json", hash: "h", issue_id: null, session_id: null, review_scope_id: null,
    })).toThrow();
  });
});
