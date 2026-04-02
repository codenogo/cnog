import { describe, it, expect } from "vitest";
import {
  CNOG_DIR, DB_PATH, WORKTREE_BASE, CHECKPOINT_DIR, CONTRACTS_DIR,
  REVIEWS_DIR, SCRATCH_DIR, PID_FILE, FEATURES_DIR, TMUX_SOCKET, SESSION_PREFIX,
  PLAN_SCHEMA_VERSION, DEFAULTS, featureDir, runSessionDir, runTaskDir,
  runScratchDir, runScratchSharedDir, runScratchRoleDir, runScratchAgentDir,
  sessionTranscriptPath, sessionTranscriptRelativePath,
  executionTaskOutputPath, executionTaskOutputRelativePath,
} from "../src/paths.js";

describe("paths constants", () => {
  it("CNOG_DIR is .cnog", () => {
    expect(CNOG_DIR).toBe(".cnog");
  });

  it("DB_PATH is under .cnog", () => {
    expect(DB_PATH).toContain(".cnog");
    expect(DB_PATH).toContain("cnog.db");
  });

  it("all subdirs are under .cnog", () => {
    expect(WORKTREE_BASE).toContain(".cnog");
    expect(CHECKPOINT_DIR).toContain(".cnog");
    expect(CONTRACTS_DIR).toContain(".cnog");
    expect(REVIEWS_DIR).toContain(".cnog");
    expect(SCRATCH_DIR).toContain(".cnog");
    expect(PID_FILE).toContain(".cnog");
  });

  it("tmux constants are correct", () => {
    expect(TMUX_SOCKET).toBe("cnog");
    expect(SESSION_PREFIX).toBe("cnog-");
  });

  it("PLAN_SCHEMA_VERSION is 3", () => {
    expect(PLAN_SCHEMA_VERSION).toBe(3);
  });

  it("featureDir generates correct path", () => {
    const dir = featureDir("auth", "/project");
    expect(dir).toContain("docs");
    expect(dir).toContain("features");
    expect(dir).toContain("auth");
  });

  it("session transcript paths are run-scoped", () => {
    expect(runSessionDir("auth", "run-1", "/project")).toContain("/project");
    expect(runSessionDir("auth", "run-1", "/project")).toContain(".cnog/features/auth/runs/run-1/sessions");
    expect(sessionTranscriptRelativePath("auth", "run-1", "builder-auth"))
      .toBe(".cnog/features/auth/runs/run-1/sessions/builder-auth.log");
    expect(sessionTranscriptPath("auth", "run-1", "builder-auth", "/project"))
      .toBe("/project/.cnog/features/auth/runs/run-1/sessions/builder-auth.log");
  });

  it("execution task output paths are run-scoped", () => {
    expect(runTaskDir("auth", "run-1", "/project")).toBe("/project/.cnog/features/auth/runs/run-1/tasks");
    expect(executionTaskOutputRelativePath("auth", "run-1", "xtask-1"))
      .toBe(".cnog/features/auth/runs/run-1/tasks/xtask-1.output");
    expect(executionTaskOutputPath("auth", "run-1", "xtask-1", "/project"))
      .toBe("/project/.cnog/features/auth/runs/run-1/tasks/xtask-1.output");
  });

  it("scratchpad paths are run-scoped and role-aware", () => {
    expect(runScratchDir("auth", "run-1", "/project"))
      .toBe("/project/.cnog/scratch/runs/run-1");
    expect(runScratchSharedDir("auth", "run-1", "/project"))
      .toBe("/project/.cnog/scratch/runs/run-1/shared");
    expect(runScratchRoleDir("auth", "run-1", "builder", "/project"))
      .toBe("/project/.cnog/scratch/runs/run-1/builder");
    expect(runScratchAgentDir("auth", "run-1", "builder", "builder-auth-1", "/project"))
      .toBe("/project/.cnog/scratch/runs/run-1/builder/builder-auth-1");
  });

  it("DEFAULTS has expected keys", () => {
    expect(DEFAULTS.bootDelayMs).toBe(2000);
    expect(DEFAULTS.tickIntervalMs).toBe(10000);
    expect(DEFAULTS.maxWip).toBe(4);
    expect(DEFAULTS.staleThresholdMs).toBe(900000);
    expect(DEFAULTS.zombieThresholdMs).toBe(3600000);
    expect(DEFAULTS.canonicalBranch).toBe("main");
  });
});
