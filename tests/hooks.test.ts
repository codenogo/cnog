import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildHooksConfig, deployHooks, getAllowedTools } from "../src/hooks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-hooks-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildHooksConfig", () => {
  it("allows write tools for builders", () => {
    const config = buildHooksConfig({
      capability: "builder",
      agentName: "builder-1",
      worktreePath: tmpDir,
    });
    expect(config.permissions.allow).toContain("Write");
    expect(config.permissions.allow).toContain("Edit");
    expect(config.permissions.deny).toEqual([]);
  });

  it("denies write tools for evaluators", () => {
    const config = buildHooksConfig({
      capability: "evaluator",
      agentName: "evaluator-1",
      worktreePath: tmpDir,
    });
    expect(config.permissions.allow).not.toContain("Write");
    expect(config.permissions.allow).not.toContain("Edit");
    expect(config.permissions.deny).toContain("Write");
    expect(config.permissions.deny).toContain("Edit");
  });

  it("denies write tools for planners", () => {
    const config = buildHooksConfig({
      capability: "planner",
      agentName: "planner-1",
      worktreePath: tmpDir,
    });
    expect(config.permissions.deny).toContain("Write");
  });

  it("adds PreToolUse hook when file scope is set", () => {
    const config = buildHooksConfig({
      capability: "builder",
      agentName: "builder-1",
      fileScope: ["src/auth.ts", "src/models.ts"],
      worktreePath: tmpDir,
    });
    expect(config.hooks.PreToolUse).toBeDefined();
    expect(config.hooks.PreToolUse).toHaveLength(1);
    expect(config.hooks.PreToolUse![0].command).toContain("src/auth.ts");
    expect(config.hooks.PreToolUse![0].command).toContain('"$REL" == "$SCOPE"');
  });

  it("omits PreToolUse hook when no file scope", () => {
    const config = buildHooksConfig({
      capability: "builder",
      agentName: "builder-1",
      worktreePath: tmpDir,
    });
    expect(config.hooks.PreToolUse).toBeUndefined();
  });

  it("uses runtime progress updates in the PostToolUse hook", () => {
    const config = buildHooksConfig({
      capability: "builder",
      agentName: "builder-1",
      worktreePath: tmpDir,
    });
    expect(config.hooks.PostToolUse).toHaveLength(1);
    expect(config.hooks.PostToolUse![0].command).toContain("cnog progress update");
    expect(config.hooks.PostToolUse![0].command).toContain("--quiet");
    expect(config.hooks.PostToolUse![0].command).toContain("CLAUDE_TOOL_NAME");
  });
});

describe("deployHooks", () => {
  it("writes settings.local.json to .claude/ in worktree", () => {
    deployHooks({
      capability: "builder",
      agentName: "builder-1",
      worktreePath: tmpDir,
    });

    const path = join(tmpDir, ".claude", "settings.local.json");
    expect(existsSync(path)).toBe(true);

    const content = JSON.parse(readFileSync(path, "utf-8"));
    expect(content.permissions).toBeDefined();
    expect(content.permissions.allow).toContain("Write");
  });

  it("creates .claude directory if missing", () => {
    deployHooks({
      capability: "evaluator",
      agentName: "evaluator-1",
      worktreePath: tmpDir,
    });

    expect(existsSync(join(tmpDir, ".claude"))).toBe(true);
  });
});

describe("getAllowedTools", () => {
  it("returns correct tools for each capability", () => {
    expect(getAllowedTools("builder")).toContain("Write");
    expect(getAllowedTools("evaluator")).not.toContain("Write");
    expect(getAllowedTools("evaluator")).not.toContain("Edit");
    expect(getAllowedTools("planner")).not.toContain("Write");
    expect(getAllowedTools("planner")).not.toContain("Edit");
  });
});
