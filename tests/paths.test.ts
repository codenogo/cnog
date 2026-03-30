import { describe, it, expect } from "vitest";
import {
  CNOG_DIR, DB_PATH, WORKTREE_BASE, CHECKPOINT_DIR, CONTRACTS_DIR,
  REVIEWS_DIR, PID_FILE, FEATURES_DIR, TMUX_SOCKET, SESSION_PREFIX,
  PLAN_SCHEMA_VERSION, DEFAULTS, featureDir,
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

  it("DEFAULTS has expected keys", () => {
    expect(DEFAULTS.bootDelayMs).toBe(2000);
    expect(DEFAULTS.tickIntervalMs).toBe(10000);
    expect(DEFAULTS.maxWip).toBe(4);
    expect(DEFAULTS.staleThresholdMs).toBe(300000);
    expect(DEFAULTS.zombieThresholdMs).toBe(900000);
    expect(DEFAULTS.canonicalBranch).toBe("main");
  });
});
