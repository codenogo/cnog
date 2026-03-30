import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import {
  generateContract,
  ContractManager,
  renderContractMd,
  renderContractForOverlay,
} from "../src/contracts.js";
import type { PlanTask } from "../src/planning/plan-factory.js";

let db: CnogDB;
let events: EventEmitter;
let tmpDir: string;

const sampleTask: PlanTask = {
  name: "Add auth models",
  files: ["src/auth.ts", "src/models/user.ts"],
  action: "Create User model with JWT claims",
  verify: ["npm test", "npx tsc --noEmit"],
  microSteps: [
    "Add jwt_claims field to User schema",
    "Update constructor to accept claims",
    "Write tests for new field",
  ],
  tdd: {
    required: true,
    failingVerify: "npm test -- auth.test",
  },
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-contract-test-"));
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

describe("generateContract", () => {
  it("generates contract from plan task", () => {
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    expect(contract.id).toMatch(/^contract-/);
    expect(contract.feature).toBe("auth");
    expect(contract.agentName).toBe("builder-auth-1");
    expect(contract.status).toBe("proposed");
    expect(contract.fileScope).toEqual(["src/auth.ts", "src/models/user.ts"]);
    expect(contract.verifyCommands).toEqual(["npm test", "npx tsc --noEmit"]);

    // Should have: action + 3 micro-steps + 2 verify + 1 TDD = 7 criteria
    expect(contract.acceptanceCriteria.length).toBe(7);
  });

  it("includes micro-steps as criteria", () => {
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    const descriptions = contract.acceptanceCriteria.map((c) => c.description);
    expect(descriptions).toContain("Add jwt_claims field to User schema");
  });

  it("includes TDD criteria when required", () => {
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    const tddCriteria = contract.acceptanceCriteria.filter((c) =>
      c.description.includes("TDD"),
    );
    expect(tddCriteria).toHaveLength(1);
  });
});

describe("ContractManager", () => {
  it("proposes and loads a contract", () => {
    const cm = new ContractManager(db, events, tmpDir);
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    cm.propose(contract);
    const loaded = cm.loadContract(contract.id, "auth");
    expect(loaded).toBeDefined();
    expect(loaded!.status).toBe("pending_review");
  });

  it("accepts a contract", () => {
    const cm = new ContractManager(db, events, tmpDir);
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });
    cm.propose(contract);

    const accepted = cm.accept(contract.id, "auth", "reviewer-1", "Looks good");
    expect(accepted).toBeDefined();
    expect(accepted!.status).toBe("accepted");
    expect(accepted!.reviewedBy).toBe("reviewer-1");
    expect(accepted!.reviewNotes).toBe("Looks good");
    expect(db.artifacts.listByRun("run-auth-1", "contract")).toHaveLength(2);
  });

  it("rejects a contract with notes", () => {
    const cm = new ContractManager(db, events, tmpDir);
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });
    cm.propose(contract);

    const rejected = cm.reject(contract.id, "auth", "reviewer-1", "File scope too broad");
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.reviewNotes).toBe("File scope too broad");
  });

  it("marks contract as completed", () => {
    const cm = new ContractManager(db, events, tmpDir);
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });
    cm.propose(contract);
    cm.accept(contract.id, "auth", "reviewer-1");

    const completed = cm.complete(contract.id, "auth");
    expect(completed!.status).toBe("completed");
  });

  it("returns null for missing contract", () => {
    const cm = new ContractManager(db, events, tmpDir);
    expect(cm.loadContract("nonexistent", "auth")).toBeNull();
  });
});

describe("rendering", () => {
  it("renders contract as markdown", () => {
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    const md = renderContractMd(contract);
    expect(md).toContain("# Sprint Contract:");
    expect(md).toContain("builder-auth-1");
    expect(md).toContain("Acceptance Criteria");
    expect(md).toContain("File Scope");
    expect(md).toContain("src/auth.ts");
  });

  it("renders contract for overlay injection", () => {
    const contract = generateContract({
      task: sampleTask,
      feature: "auth",
      agentName: "builder-auth-1",
      runId: "run-auth-1",
    });

    const overlay = renderContractForOverlay(contract);
    expect(overlay).toContain("## Sprint Contract");
    expect(overlay).toContain("pre-approved");
    expect(overlay).toContain("MUST meet ALL");
  });
});
