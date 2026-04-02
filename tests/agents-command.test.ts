import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockBuildContext,
  mockRequestEvaluation,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn((fn: (db: unknown) => unknown) => fn({})),
  mockBuildContext: vi.fn(),
  mockRequestEvaluation: vi.fn(),
}));

vi.mock("../src/commands/context.js", () => ({
  withDb: mockWithDb,
  buildContext: mockBuildContext,
}));

import { evaluateCommand } from "../src/commands/agents.js";

describe("evaluateCommand", () => {
  beforeEach(() => {
    mockWithDb.mockClear();
    mockBuildContext.mockReset();
    mockRequestEvaluation.mockReset();
    mockBuildContext.mockReturnValue({
      config: {
        agents: { runtime: "claude" },
      },
      execution: {
        requestEvaluation: mockRequestEvaluation,
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("delegates manual evaluation to the execution engine", () => {
    mockRequestEvaluation.mockReturnValue({
      status: "spawned",
      agent: "evaluator-auth",
      task: "implementation evaluation",
    });

    evaluateCommand("auth");

    expect(mockRequestEvaluation).toHaveBeenCalledWith("auth", "claude");
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Spawned evaluator: evaluator-auth"));
  });

  it("surfaces task-level evaluation blockers", () => {
    mockRequestEvaluation.mockReturnValue({
      status: "blocked",
      reason: "Review-scope verification failed",
    });

    expect(() => evaluateCommand("auth")).toThrow("Review-scope verification failed");
  });
});
