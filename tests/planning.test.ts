import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveProfile,
  getVerifyCommands,
  getMaxConcurrent,
  requiresReview,
  requiresPR,
} from "../src/planning/profiles.js";
import { validatePlan, loadLatestPlan } from "../src/planning/plan-factory.js";
import type { Plan } from "../src/planning/plan-factory.js";

describe("profiles", () => {
  it("resolves a known profile", () => {
    const profile = resolveProfile("feature-delivery");
    expect(profile.execution.maxConcurrent).toBe(4);
    expect(profile.verify.commands).toContain("npm test");
    expect(profile.ship.requirePullRequest).toBe(true);
  });

  it("returns defaults for unknown profile", () => {
    const profile = resolveProfile("nonexistent");
    expect(profile.execution.maxConcurrent).toBe(4);
    expect(profile.verify.commands).toEqual([]);
  });

  it("getVerifyCommands returns commands", () => {
    expect(getVerifyCommands("feature-delivery")).toContain("npm test");
  });

  it("getMaxConcurrent returns limit", () => {
    expect(getMaxConcurrent("migration-rollout")).toBe(1);
  });

  it("requiresReview checks auto-review", () => {
    expect(requiresReview("feature-delivery")).toBe(true);
    expect(requiresReview("local-dev")).toBe(false);
  });

  it("requiresPR checks PR requirement", () => {
    expect(requiresPR("feature-delivery")).toBe(true);
    expect(requiresPR("local-dev")).toBe(false);
  });
});

describe("validatePlan", () => {
  const validPlan: Plan = {
    schemaVersion: 3,
    feature: "auth",
    planNumber: "01",
    goal: "Add JWT auth",
    tasks: [
      {
        name: "Add models",
        files: ["src/models.ts"],
        action: "Create user model",
        verify: ["npm test"],
      },
    ],
    planVerify: ["npm test"],
    commitMessage: "feat(auth): add JWT auth",
  };

  it("passes for a valid plan", () => {
    expect(validatePlan(validPlan)).toEqual([]);
  });

  it("catches missing feature", () => {
    const plan = { ...validPlan, feature: "" };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.field === "feature")).toBe(true);
  });

  it("catches empty tasks", () => {
    const plan = { ...validPlan, tasks: [] };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.field === "tasks")).toBe(true);
  });

  it("catches missing task name", () => {
    const plan = {
      ...validPlan,
      tasks: [{ name: "", files: ["a.ts"], action: "do", verify: ["test"] }],
    };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.message.includes("Missing task name"))).toBe(true);
  });

  it("catches tasks without files", () => {
    const plan = {
      ...validPlan,
      tasks: [{ name: "task1", files: [], action: "do", verify: ["test"] }],
    };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.message.includes("list files"))).toBe(true);
  });

  it("catches duplicate task names", () => {
    const plan = {
      ...validPlan,
      tasks: [
        { name: "task1", files: ["a.ts"], action: "do", verify: ["test"] },
        { name: "task1", files: ["b.ts"], action: "do2", verify: ["test"] },
      ],
    };
    const errors = validatePlan(plan);
    expect(errors.some((e) => e.message.includes("Duplicate"))).toBe(true);
  });
});

describe("loadLatestPlan", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-plan-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads the highest-numbered plan for a feature", () => {
    const featureDir = join(tmpDir, "docs", "planning", "work", "features", "auth");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, "01-PLAN.json"), JSON.stringify({
      schemaVersion: 3,
      feature: "auth",
      planNumber: "01",
      goal: "old",
      tasks: [{ name: "old", files: ["a.ts"], action: "old", verify: ["npm test"] }],
      planVerify: ["npm test"],
      commitMessage: "feat(auth): old",
    }));
    writeFileSync(join(featureDir, "02-PLAN.json"), JSON.stringify({
      schemaVersion: 3,
      feature: "auth",
      planNumber: "02",
      goal: "new",
      tasks: [{ name: "new", files: ["b.ts"], action: "new", verify: ["npm test"] }],
      planVerify: ["npm test"],
      commitMessage: "feat(auth): new",
    }));

    const latest = loadLatestPlan("auth", tmpDir);
    expect(latest?.planNumber).toBe("02");
    expect(latest?.goal).toBe("new");
  });
});
