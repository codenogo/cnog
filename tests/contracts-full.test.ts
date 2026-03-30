/**
 * Additional contracts tests — fail() method.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { generateContract, ContractManager } from "../src/contracts.js";

let db: CnogDB;
let events: EventEmitter;
let tmpDir: string;

const task = {
  name: "Test task",
  files: ["src/test.ts"],
  action: "Do testing",
  verify: ["npm test"],
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-contracts-full-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  events = new EventEmitter(db);
  db.runs.create({
    id: "run-auth-1",
    feature: "auth",
    plan_number: "01",
    status: "contract",
    phase_reason: null,
    profile: null,
    tasks: null,
    review: null,
    ship: null,
    worktree_path: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ContractManager.fail()", () => {
  it("marks a contract as failed", () => {
    const cm = new ContractManager(db, events, tmpDir);
    const contract = generateContract({ task, feature: "auth", agentName: "b1", runId: "run-auth-1" });
    cm.propose(contract);
    cm.accept(contract.id, "auth", "reviewer-1");

    const failed = cm.fail(contract.id, "auth");
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
  });

  it("returns null for nonexistent contract", () => {
    const cm = new ContractManager(db, events, tmpDir);
    expect(cm.fail("nope", "auth")).toBeNull();
  });
});
