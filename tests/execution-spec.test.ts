import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildExecutionSpec,
  findPlanTaskForIssue,
  planTaskKeyFor,
} from "../src/execution-spec.js";
import type { Issue } from "../src/memory.js";
import type { Plan } from "../src/planning/plan-factory.js";

describe("execution spec bridge", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it("derives package-aware verify commands from file scope", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-execution-spec-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({
      scripts: {
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
    }, null, 2), "utf-8");

    const plan: Plan = {
      schemaVersion: 3,
      feature: "auth",
      planNumber: "01",
      goal: "Deliver auth",
      profile: "feature-delivery",
      tasks: [{
        name: "Task A",
        files: ["src/auth.ts"],
        action: "Implement auth flow",
        verify: ["vitest run tests/auth.test.ts"],
      }],
      planVerify: ["npm test"],
      commitMessage: "feat(auth): deliver auth",
    };

    const spec = buildExecutionSpec({
      plan,
      task: plan.tasks[0],
      taskIndex: 0,
      profileName: "feature-delivery",
      projectRoot: tmpDir,
    });

    expect(spec.packageVerifyCommands).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm test",
    ]);
    expect(spec.verifyCommands).toEqual([
      "vitest run tests/auth.test.ts",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npx tsc --noEmit",
    ]);
  });

  it("matches plan tasks by stable plan-task key instead of issue title", () => {
    const plan: Plan = {
      schemaVersion: 3,
      feature: "billing",
      planNumber: "02",
      goal: "Deliver billing",
      tasks: [
        {
          name: "Task A",
          files: ["src/a.ts"],
          action: "Implement A",
          verify: ["npm test"],
        },
        {
          name: "Task B",
          files: ["src/b.ts"],
          action: "Implement B",
          verify: ["npm run lint"],
        },
      ],
      planVerify: ["npm test"],
      commitMessage: "feat(billing): deliver billing",
    };

    const issue: Pick<Issue, "title" | "metadata"> = {
      title: "Old title that no longer matches",
      metadata: {
        planTaskKey: planTaskKeyFor(plan, 1),
        planTaskIndex: 1,
      },
    };

    const match = findPlanTaskForIssue(issue, plan);
    expect(match).not.toBeNull();
    expect(match?.task.name).toBe("Task B");
    expect(match?.taskIndex).toBe(1);
  });

  it("prefers the stable plan-task key over a stale stored index", () => {
    const plan: Plan = {
      schemaVersion: 3,
      feature: "billing",
      planNumber: "02",
      goal: "Deliver billing",
      tasks: [
        {
          name: "Task A",
          files: ["src/a.ts"],
          action: "Implement A",
          verify: ["npm test"],
        },
        {
          name: "Task B",
          files: ["src/b.ts"],
          action: "Implement B",
          verify: ["npm run lint"],
        },
      ],
      planVerify: ["npm test"],
      commitMessage: "feat(billing): deliver billing",
    };

    const issue: Pick<Issue, "title" | "metadata"> = {
      title: "Stale title",
      metadata: {
        planTaskKey: planTaskKeyFor(plan, 1),
        planTaskIndex: 0,
      },
    };

    const match = findPlanTaskForIssue(issue, plan);
    expect(match?.task.name).toBe("Task B");
    expect(match?.taskIndex).toBe(1);
  });
});
