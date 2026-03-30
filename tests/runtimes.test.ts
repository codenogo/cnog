import { describe, it, expect } from "vitest";
import { getRuntime, hasRuntime, listRuntimes, registerRuntime } from "../src/runtimes/index.js";
import type { AgentRuntime } from "../src/runtimes/types.js";

describe("runtime registry", () => {
  it("default runtime is claude", () => {
    const rt = getRuntime();
    expect(rt.id).toBe("claude");
    expect(rt.name).toBe("Claude Code");
    expect(rt.instructionFile).toBe("CLAUDE.md");
  });

  it("buildCommand returns claude command", () => {
    const rt = getRuntime("claude");
    const cmd = rt.buildCommand({
      sessionName: "cnog-builder",
      workingDir: "/tmp/wt",
      agentName: "builder-1",
    });
    expect(cmd).toContain("claude");
    expect(cmd).toContain("--dangerously-skip-permissions");
  });

  it("throws for an unknown runtime", () => {
    expect(() => getRuntime("nonexistent")).toThrow("Unknown runtime");
  });

  it("lists registered runtimes", () => {
    const ids = listRuntimes();
    expect(ids).toContain("claude");
    expect(hasRuntime("claude")).toBe(true);
  });

  it("can register custom runtime", () => {
    const custom: AgentRuntime = {
      id: "test-runtime",
      name: "Test Runtime",
      instructionFile: "TEST.md",
      buildCommand: () => "echo test",
    };
    registerRuntime(custom);
    const rt = getRuntime("test-runtime");
    expect(rt.id).toBe("test-runtime");
    expect(rt.buildCommand({ sessionName: "", workingDir: "", agentName: "" })).toBe("echo test");
  });
});
