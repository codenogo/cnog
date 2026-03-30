import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadBaseDefinition, generateOverlay, writeOverlay } from "../src/overlay.js";
import type { SprintContract } from "../src/types.js";
import { DEFAULT_REVIEW_RUBRIC } from "../src/grading.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-overlay-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadBaseDefinition", () => {
  it("loads an agent definition file", () => {
    const agentsDir = join(tmpDir, "agents");
    mkdirSync(agentsDir);
    writeFileSync(join(agentsDir, "builder.md"), "# Builder\nBuild stuff.");

    const content = loadBaseDefinition("builder", agentsDir);
    expect(content).toContain("# Builder");
    expect(content).toContain("Build stuff.");
  });

  it("returns fallback for missing definition", () => {
    const content = loadBaseDefinition("nonexistent", join(tmpDir, "agents"));
    expect(content).toContain("nonexistent agent");
    expect(content).toContain("No base definition found");
  });
});

describe("generateOverlay", () => {
  it("generates basic overlay with identity and task", () => {
    const overlay = generateOverlay({
      agentName: "builder-auth-1",
      capability: "builder",
      feature: "auth",
      branch: "cnog/auth/builder-auth-1",
      taskId: "cn-abc123",
      taskPrompt: "Implement JWT validation",
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("# Task: cn-abc123");
    expect(overlay).toContain("Agent: builder-auth-1");
    expect(overlay).toContain("Capability: builder");
    expect(overlay).toContain("Feature: auth");
    expect(overlay).toContain("Branch: cnog/auth/builder-auth-1");
    expect(overlay).toContain("Implement JWT validation");
    expect(overlay).toContain("cnog heartbeat builder-auth-1");
    expect(overlay).toContain("cnog mail check --agent builder-auth-1");
    expect(overlay).toContain('--from builder-auth-1 --type worker_done');
  });

  it("includes file scope section", () => {
    const overlay = generateOverlay({
      agentName: "builder-1",
      capability: "builder",
      feature: "auth",
      taskPrompt: "task",
      fileScope: ["src/auth.ts", "src/models.ts"],
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## File Scope");
    expect(overlay).toContain("- src/auth.ts");
    expect(overlay).toContain("- src/models.ts");
  });

  it("includes verify commands section", () => {
    const overlay = generateOverlay({
      agentName: "builder-1",
      capability: "builder",
      feature: "auth",
      taskPrompt: "task",
      verifyCommands: ["npm test", "npx tsc --noEmit"],
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Verify Commands");
    expect(overlay).toContain("`npm test`");
    expect(overlay).toContain("`npx tsc --noEmit`");
  });

  it("includes sprint contract when provided", () => {
    const contract: SprintContract = {
      id: "contract-abc",
      taskId: "cn-abc",
      runId: "",
      feature: "auth",
      agentName: "builder-1",
      acceptanceCriteria: [
        { description: "JWT validation works", testable: true },
        { description: "Tests pass", testable: true, verifyCommand: "npm test" },
      ],
      verifyCommands: ["npm test"],
      fileScope: ["src/auth.ts"],
      status: "accepted",
      proposedAt: new Date().toISOString(),
      reviewedBy: "reviewer-1",
      reviewedAt: new Date().toISOString(),
      reviewNotes: null,
    };

    const overlay = generateOverlay({
      agentName: "builder-1",
      capability: "builder",
      feature: "auth",
      taskPrompt: "task",
      contract,
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Sprint Contract");
    expect(overlay).toContain("pre-approved");
    expect(overlay).toContain("JWT validation works");
  });

  it("includes grading rubric when provided", () => {
    const overlay = generateOverlay({
      agentName: "evaluator-1",
      capability: "evaluator",
      feature: "auth",
      branch: "cnog/auth/evaluator-1",
      taskPrompt: "review the code",
      rubric: DEFAULT_REVIEW_RUBRIC,
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Grading Rubric");
    expect(overlay).toContain("functionality");
    expect(overlay).toContain("threshold");
    expect(overlay).toContain('--from evaluator-1 --type result');
  });

  it("includes handoff context when provided", () => {
    const overlay = generateOverlay({
      agentName: "builder-1",
      capability: "builder",
      feature: "auth",
      taskPrompt: "continue the work",
      handoffContext: "Previous agent completed models. Still need endpoints.",
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Previous Session Context");
    expect(overlay).toContain("context reset");
    expect(overlay).toContain("completed models");
  });

  it("includes checkpoint save command", () => {
    const overlay = generateOverlay({
      agentName: "builder-1",
      capability: "builder",
      feature: "auth",
      taskPrompt: "task",
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("cnog checkpoint save");
  });
});

describe("writeOverlay", () => {
  it("writes the configured runtime instruction file to the worktree", () => {
    const wtPath = join(tmpDir, "worktree");
    mkdirSync(wtPath, { recursive: true });

    writeOverlay(wtPath, "CLAUDE.md", "# Test overlay content");

    const content = readFileSync(join(wtPath, "CLAUDE.md"), "utf-8");
    expect(content).toBe("# Test overlay content");
  });

  it("creates directory if missing", () => {
    const wtPath = join(tmpDir, "deep", "nested", "worktree");
    writeOverlay(wtPath, "CLAUDE.md", "content");

    const content = readFileSync(join(wtPath, "CLAUDE.md"), "utf-8");
    expect(content).toBe("content");
  });
});
