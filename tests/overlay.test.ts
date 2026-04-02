import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadBaseDefinition, generateOverlay, writeOverlay } from "../src/overlay.js";
import type { SprintContract } from "../src/types.js";
import { DEFAULT_REVIEW_RUBRIC } from "../src/grading.js";
import type { WorkerContextBundle } from "../src/context-builder.js";
import {
  buildBuilderCompletionCommand,
  buildLaunchPrompt,
  buildGenericCompletionCommand,
  buildImplementationReviewResultCommand,
  buildWorkerProtocolContract,
} from "../src/prompt-contract.js";
import type { WorkerAssignmentSpec, WorkerProtocolContract } from "../src/prompt-contract.js";

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
  function builderProtocol(): WorkerProtocolContract {
    return buildWorkerProtocolContract({
      role: "builder",
      executionKind: "build",
      agentName: "builder-auth-1",
      feature: "auth",
      runId: "run-auth-1",
      executionTaskId: "xtask-auth-1",
      issueId: "cn-abc123",
      branch: "cnog/auth/builder-auth-1",
      fileScope: ["src/auth.ts", "src/models.ts"],
      dependencyBranches: ["cnog/auth/shared"],
      localSanityChecks: ["npm run lint"],
      completionCommand: buildBuilderCompletionCommand({
        agentName: "builder-auth-1",
        runId: "run-auth-1",
        feature: "auth",
        executionTaskId: "xtask-auth-1",
        issueId: "cn-abc123",
        branch: "cnog/auth/builder-auth-1",
      }),
      resultPayloadKind: "builder_completion",
      resultRequiredFields: ["summary"],
      escalationCodes: ["scope_violation_required", "missing_dependency", "verification_drift", "unexpected_repo_state", "external_blocker"],
    });
  }

  function builderAssignment(): WorkerAssignmentSpec {
    return {
      kind: "builder_assignment",
      objective: "Implement JWT validation",
      planTaskKey: "auth:01:00",
      taskIndex: 0,
      taskName: "Implement JWT validation",
      action: "Add JWT validation to the auth flow.",
      planGoal: "Ship secure auth",
      fileScope: ["src/auth.ts", "src/models.ts"],
      microSteps: ["Add validator", "Wire request middleware"],
      contextLinks: ["docs/auth.md"],
      canonicalVerifyCommands: ["npm test", "npx tsc --noEmit"],
      packageVerifyCommands: ["npm run lint"],
    };
  }

  function builderContext(): WorkerContextBundle {
    return {
      bundleVersion: 1,
      workspaceRoot: "/repo",
      worktreePath: "/repo/.cnog/worktrees/builder-auth-1",
      scratchpad: {
        root: "/repo/.cnog/scratch/runs/run-auth-1",
        shared: "/repo/.cnog/scratch/runs/run-auth-1/shared",
        role: "/repo/.cnog/scratch/runs/run-auth-1/builder",
        agent: "/repo/.cnog/scratch/runs/run-auth-1/builder/builder-auth-1",
      },
      layers: [
        {
          id: "git_snapshot",
          title: "Git Snapshot",
          bullets: [
            "Workspace root: /repo",
            "Worktree path: /repo/.cnog/worktrees/builder-auth-1",
            "Canonical branch: main",
            "Agent branch: cnog/auth/builder-auth-1",
          ],
        },
        {
          id: "scratchpad",
          title: "Run Scratchpad",
          bullets: ["Shared notes: /repo/.cnog/scratch/runs/run-auth-1/shared"],
          body: "Treat the scratchpad as mutable coordination space.",
        },
      ],
    };
  }

  it("generates basic overlay with identity and task", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("# cnog Worker Contract");
    expect(overlay).toContain("Agent: builder-auth-1");
    expect(overlay).toContain("Role: builder");
    expect(overlay).toContain("Feature: auth");
    expect(overlay).toContain("Branch: cnog/auth/builder-auth-1");
    expect(overlay).toContain("## Protocol Contract");
    expect(overlay).toContain("## Assignment Spec");
    expect(overlay).toContain("Implement JWT validation");
    expect(overlay).toContain("cnog heartbeat builder-auth-1");
    expect(overlay).toContain("cnog mail check --agent builder-auth-1");
    expect(overlay).toContain("cnog report builder-complete");
  });

  it("includes file scope section", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("### Concurrency Contract");
    expect(overlay).toContain("- src/auth.ts");
    expect(overlay).toContain("- src/models.ts");
  });

  it("includes verify commands section", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("### Verification Contract");
    expect(overlay).toContain("npm test");
    expect(overlay).toContain("npx tsc --noEmit");
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
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      contract,
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Sprint Contract");
    expect(overlay).toContain("pre-approved");
    expect(overlay).toContain("JWT validation works");
  });

  it("includes grading rubric when provided", () => {
    const protocol = buildWorkerProtocolContract({
      role: "evaluator",
      executionKind: "implementation_review",
      agentName: "evaluator-1",
      feature: "auth",
      runId: "run-auth-1",
      executionTaskId: "xtask-eval-1",
      reviewScopeId: "scope-1",
      scopeHash: "hash-1",
      completionCommand: buildImplementationReviewResultCommand({
        agentName: "evaluator-1",
        scopeId: "scope-1",
        scopeHash: "hash-1",
      }),
      resultPayloadKind: "implementation_review",
      resultRequiredFields: ["summary", "scopeId", "scopeHash", "verdict", "scores"],
      escalationCodes: ["verification_drift", "unexpected_repo_state"],
    });
    const overlay = generateOverlay({
      protocol,
      assignment: {
        kind: "implementation_review_assignment",
        objective: "Evaluate auth scope",
        runId: "run-auth-1",
        feature: "auth",
        scopeId: "scope-1",
        scopeHash: "hash-1",
        branches: ["cnog/auth/builder-1"],
        contractArtifacts: [{ path: ".cnog/features/auth/runs/run-auth-1/contract.json", hash: "abc" }],
        verifyArtifacts: [{ path: ".cnog/features/auth/runs/run-auth-1/verify.json", hash: "def" }],
        rubric: DEFAULT_REVIEW_RUBRIC,
      },
      context: builderContext(),
      rubric: DEFAULT_REVIEW_RUBRIC,
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Grading Rubric");
    expect(overlay).toContain("functionality");
    expect(overlay).toContain("threshold");
    expect(overlay).toContain("implementation_review");
  });

  it("includes handoff context when provided", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      handoffContext: "Previous agent completed models. Still need endpoints.",
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Previous Session Context");
    expect(overlay).toContain("context reset");
    expect(overlay).toContain("completed models");
  });

  it("includes checkpoint save command", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("cnog checkpoint save");
  });

  it("keeps the overlay runtime-agnostic instead of hardcoding CLAUDE.md", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(process.cwd(), "agents"),
    });

    expect(overlay).not.toContain("CLAUDE.md");
    expect(overlay).toContain("this instruction file");
    expect(overlay).toContain("execution contract above");
  });

  it("includes layered context and scratchpad guidance", () => {
    const overlay = generateOverlay({
      protocol: builderProtocol(),
      assignment: builderAssignment(),
      context: builderContext(),
      agentsDir: join(tmpDir, "agents"),
    });

    expect(overlay).toContain("## Layered Context");
    expect(overlay).toContain("### Git Snapshot");
    expect(overlay).toContain("### Run Scratchpad");
    expect(overlay).toContain("/repo/.cnog/scratch/runs/run-auth-1/shared");
  });
});

describe("buildLaunchPrompt", () => {
  it("uses the configured runtime instruction filename when provided", () => {
    const prompt = buildLaunchPrompt({
      kind: "builder_assignment",
      objective: "Implement JWT validation",
      planTaskKey: "auth:01:00",
      taskIndex: 0,
      taskName: "Implement JWT validation",
      action: "Add JWT validation to the auth flow.",
      planGoal: "Ship secure auth",
      fileScope: ["src/auth.ts"],
      microSteps: [],
      contextLinks: [],
      canonicalVerifyCommands: ["npm test"],
      packageVerifyCommands: [],
    }, "TEST.md");

    expect(prompt).toContain("Read TEST.md");
    expect(prompt).not.toContain("CLAUDE.md");
  });

  it("falls back to runtime-agnostic wording when no instruction filename is provided", () => {
    const prompt = buildLaunchPrompt({
      kind: "builder_assignment",
      objective: "Implement JWT validation",
      planTaskKey: "auth:01:00",
      taskIndex: 0,
      taskName: "Implement JWT validation",
      action: "Add JWT validation to the auth flow.",
      planGoal: "Ship secure auth",
      fileScope: ["src/auth.ts"],
      microSteps: [],
      contextLinks: [],
      canonicalVerifyCommands: ["npm test"],
      packageVerifyCommands: [],
    });

    expect(prompt).toContain("runtime instruction file");
    expect(prompt).not.toContain("CLAUDE.md");
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
