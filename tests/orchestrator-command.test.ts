import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRunDaemon,
  mockExistsSync,
  mockIsOrchestratorRunning,
  mockReadPidFile,
  mockFindProjectRoot,
} = vi.hoisted(() => ({
  mockRunDaemon: vi.fn(() => Promise.resolve()),
  mockExistsSync: vi.fn(),
  mockIsOrchestratorRunning: vi.fn(() => false),
  mockReadPidFile: vi.fn(() => null),
  mockFindProjectRoot: vi.fn(() => "/repo"),
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    closeSync: vi.fn(),
    existsSync: mockExistsSync,
    openSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

vi.mock("../src/daemon.js", () => ({
  runDaemon: mockRunDaemon,
}));

vi.mock("../src/config.js", () => ({
  removePidFile: vi.fn(),
  isOrchestratorRunning: mockIsOrchestratorRunning,
  readPidFile: mockReadPidFile,
}));

vi.mock("../src/paths.js", () => ({
  CNOG_DIR: ".cnog",
  LOG_FILE: ".cnog/orchestrator.log",
  findProjectRoot: mockFindProjectRoot,
}));

import { startCommand } from "../src/commands/orchestrator.js";

beforeEach(() => {
  mockRunDaemon.mockClear();
  mockExistsSync.mockReset();
  mockIsOrchestratorRunning.mockReset();
  mockIsOrchestratorRunning.mockReturnValue(false);
  mockReadPidFile.mockReset();
  mockReadPidFile.mockReturnValue(null);
  mockFindProjectRoot.mockReset();
  mockFindProjectRoot.mockReturnValue("/repo");
});

describe("startCommand", () => {
  it("runs the daemon in-process with the discovered cnog root in foreground mode", () => {
    mockExistsSync.mockReturnValue(true);

    const started = startCommand({ foreground: true });

    expect(started).toBe(true);
    expect(mockRunDaemon).toHaveBeenCalledWith("/repo", { foreground: true });
  });

  it("raises NOT_INITIALIZED before trying to start the daemon", () => {
    mockExistsSync.mockReturnValue(false);

    expect(() => startCommand({ foreground: true })).toThrow("cnog not initialized");
    expect(mockRunDaemon).not.toHaveBeenCalled();
  });
});
