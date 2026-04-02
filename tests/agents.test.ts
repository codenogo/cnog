import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({
  worktreePath: "",
  worktreeCreate: vi.fn(),
  worktreeRemove: vi.fn(),
  worktreeDeleteBranch: vi.fn(),
  tmuxSpawnSession: vi.fn(),
  tmuxPipePaneToFiles: vi.fn(),
  tmuxSendKeys: vi.fn(),
  childSpawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.childSpawnSync,
}));

vi.mock("../src/worktree.js", () => ({
  create: mocks.worktreeCreate,
  remove: mocks.worktreeRemove,
  deleteBranch: mocks.worktreeDeleteBranch,
}));

vi.mock("../src/tmux.js", () => ({
  isAvailable: () => true,
  spawnSession: mocks.tmuxSpawnSession,
  pipePaneToFiles: mocks.tmuxPipePaneToFiles,
  sendKeys: mocks.tmuxSendKeys,
  killSession: vi.fn(() => true),
  sessionNameFor: (agentName: string) => `cnog-${agentName}`,
}));

vi.mock("../src/runtimes/index.js", () => ({
  getRuntime: () => ({
    id: "test-runtime",
    name: "Test Runtime",
    instructionFile: "PLAN.md",
    buildCommand: () => "test-runtime --run",
  }),
}));

import { CnogDB } from "../src/db.js";
import { EventEmitter } from "../src/events.js";
import { loadArtifactJson } from "../src/artifacts.js";
import { AgentManager } from "../src/agents.js";

describe("AgentManager planner spawn", () => {
  let tmpDir: string;
  let db: CnogDB;
  let events: EventEmitter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-agents-test-"));
    db = new CnogDB(join(tmpDir, "test.db"));
    events = new EventEmitter(db);

    mocks.worktreePath = join(tmpDir, "worktrees", "planner-auth");
    mkdirSync(mocks.worktreePath, { recursive: true });
    mocks.worktreeCreate.mockReset();
    mocks.worktreeCreate.mockImplementation((agentName: string, feature: string) => ({
      path: mocks.worktreePath,
      branch: `cnog/${feature}/${agentName}`,
      head: "abc123",
      existed: false,
      featureSlug: feature,
      agentSlug: agentName,
    }));
    mocks.worktreeRemove.mockReset();
    mocks.worktreeDeleteBranch.mockReset();
    mocks.tmuxSpawnSession.mockReset();
    mocks.tmuxSpawnSession.mockReturnValue(12345);
    mocks.tmuxPipePaneToFiles.mockReset();
    mocks.tmuxPipePaneToFiles.mockReturnValue(true);
    mocks.tmuxSendKeys.mockReset();
    mocks.childSpawnSync.mockClear();

    db.runs.create({
      id: "run-auth-1",
      feature: "auth",
      plan_number: "01",
      status: "plan",
      phase_reason: "planner requested",
      profile: null,
      tasks: null,
      review: null,
      ship: null,
      worktree_path: null,
    });

    const featureDir = join(tmpDir, "docs", "planning", "work", "features", "auth");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(featureDir, "01-PLAN.json"), JSON.stringify({
      schemaVersion: 3,
      feature: "auth",
      planNumber: "01",
      goal: "Ship auth",
      tasks: [
        {
          name: "Inspect auth flows",
          files: ["src/auth.ts"],
          action: "Understand the auth flow",
          verify: ["npm test"],
        },
      ],
      planVerify: ["npm test"],
      commitMessage: "feat(auth): ship auth",
    }), "utf-8");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a first-class planner assignment and concrete completion path by default", () => {
    const manager = new AgentManager(db, events, tmpDir, join(process.cwd(), "agents"));
    const identity = manager.allocateIdentity("planner-auth");

    manager.spawn({
      identity,
      runtimeId: "test-runtime",
      capability: "planner",
      feature: "auth",
      taskPrompt: "Plan the auth delivery work for concurrent builders.",
      runId: "run-auth-1",
      baseBranch: "main",
    });

    const promptArtifact = db.artifacts
      .listByRun("run-auth-1")
      .find((artifact) => artifact.type === "prompt-contract");
    expect(promptArtifact).toBeDefined();

    const payload = loadArtifactJson<{
      assignment: {
        kind: string;
        outputPath?: string;
        objective?: string;
      };
      protocol: {
        completionCommand: string;
      };
      launchPrompt: string;
      instructionFile: string;
    }>(promptArtifact!, tmpDir);

    expect(payload).not.toBeNull();
    expect(payload?.assignment.kind).toBe("planner_assignment");
    expect(payload?.assignment.objective).toBe("Plan the auth delivery work for concurrent builders.");
    expect(payload?.assignment.outputPath).toBe("docs/planning/work/features/auth/02-PLAN.json");
    expect(payload?.protocol.completionCommand).toContain("docs/planning/work/features/auth/02-PLAN.json");
    expect(payload?.protocol.completionCommand).not.toContain("<NN>");
    expect(payload?.instructionFile).toBe("PLAN.md");
    expect(payload?.launchPrompt).toContain("produce the requested plan artifact");

    expect(mocks.tmuxSendKeys).toHaveBeenCalledWith(
      "cnog-planner-auth",
      expect.stringContaining("Read PLAN.md and produce the requested plan artifact."),
    );
  });
});
