import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  nextPlanNumber,
  loadPlan,
  writePlan,
  renderPlanMd,
  createBlankPlan,
} from "../src/planning/plan-factory.js";
import type { Plan } from "../src/planning/plan-factory.js";

let tmpDir: string;

const samplePlan: Plan = {
  schemaVersion: 3,
  feature: "auth",
  planNumber: "01",
  goal: "Add JWT authentication",
  tasks: [
    {
      name: "Add models",
      files: ["src/models.ts"],
      action: "Create user model with JWT claims",
      verify: ["npm test"],
      microSteps: ["Add field", "Write test"],
      blockedBy: [],
    },
    {
      name: "Add endpoints",
      files: ["src/routes.ts"],
      action: "Create login/register endpoints",
      verify: ["npm test"],
      blockedBy: ["Add models"],
    },
  ],
  planVerify: ["npm test", "npx tsc --noEmit"],
  commitMessage: "feat(auth): add JWT authentication",
  profile: "feature-delivery",
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-planfactory-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("nextPlanNumber", () => {
  it("returns 01 for empty feature dir", () => {
    expect(nextPlanNumber("auth", tmpDir)).toBe("01");
  });

  it("returns 01 when feature dir does not exist", () => {
    expect(nextPlanNumber("nonexistent", tmpDir)).toBe("01");
  });

  it("increments from existing plans", () => {
    const dir = join(tmpDir, "docs", "planning", "work", "features", "auth");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-PLAN.json"), "{}");
    writeFileSync(join(dir, "02-PLAN.json"), "{}");

    expect(nextPlanNumber("auth", tmpDir)).toBe("03");
  });
});

describe("writePlan + loadPlan", () => {
  it("writes and loads a plan roundtrip", () => {
    const path = writePlan(samplePlan, tmpDir);
    expect(path).toContain("01-PLAN.json");

    const loaded = loadPlan("auth", "01", tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.feature).toBe("auth");
    expect(loaded!.goal).toBe("Add JWT authentication");
    expect(loaded!.tasks).toHaveLength(2);
  });

  it("loadPlan returns null for missing plan", () => {
    expect(loadPlan("nonexistent", "01", tmpDir)).toBeNull();
  });

  it("loadPlan returns null for corrupted JSON", () => {
    const dir = join(tmpDir, "docs", "planning", "work", "features", "bad");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-PLAN.json"), "{invalid json");

    expect(loadPlan("bad", "01", tmpDir)).toBeNull();
  });
});

describe("renderPlanMd", () => {
  it("renders plan as readable markdown", () => {
    const md = renderPlanMd(samplePlan);
    expect(md).toContain("# Plan: auth (01)");
    expect(md).toContain("Add JWT authentication");
    expect(md).toContain("### Add models");
    expect(md).toContain("### Add endpoints");
    expect(md).toContain("**Files:**");
    expect(md).toContain("`src/models.ts`");
    expect(md).toContain("**Blocked by:** Add models");
    expect(md).toContain("## Plan Verify");
    expect(md).toContain("`npm test`");
  });
});

describe("createBlankPlan", () => {
  it("creates a blank plan with next number", () => {
    const plan = createBlankPlan("auth", tmpDir);
    expect(plan.feature).toBe("auth");
    expect(plan.planNumber).toBe("01");
    expect(plan.schemaVersion).toBe(3);
    expect(plan.tasks).toEqual([]);
    expect(plan.goal).toBe("");
  });
});
