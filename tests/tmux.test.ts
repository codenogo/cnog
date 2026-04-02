import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = spawnSync as ReturnType<typeof vi.fn>;

import {
  isAvailable,
  _tmux,
  listSessions,
  isSessionAlive,
  spawnSession,
  sendKeys,
  killSession,
  capturePane,
  pipePaneToFiles,
  pipePaneToFile,
  getPanePid,
  sessionNameFor,
  TMUX_SOCKET,
} from "../src/tmux.js";

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe("isAvailable", () => {
  it("returns true when tmux is found", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "tmux 3.4",
      stderr: "",
      error: undefined,
    });

    expect(isAvailable()).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      ["-V"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns false when tmux is not found", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });

    expect(isAvailable()).toBe(false);
  });
});

describe("_tmux", () => {
  it("passes args through the cnog socket", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "ok",
      stderr: "",
      error: undefined,
    });

    const result = _tmux("has-session", "-t", "test");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      ["-L", TMUX_SOCKET, "has-session", "-t", "test"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("returns status 127 when tmux binary not found", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });

    const result = _tmux("list-sessions");
    expect(result.status).toBe(127);
    expect(result.stderr).toBe("tmux not found");
  });
});

describe("listSessions", () => {
  it("parses session output correctly", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "cnog-builder:12345:/home/user/project\ncnog-planner:67890:/tmp/work\n",
      stderr: "",
      error: undefined,
    });

    const sessions = listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({
      name: "cnog-builder",
      pid: 12345,
      workingDir: "/home/user/project",
    });
    expect(sessions[1]).toEqual({
      name: "cnog-planner",
      pid: 67890,
      workingDir: "/tmp/work",
    });
  });

  it("returns empty array when no sessions exist", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "no server running",
      error: undefined,
    });

    expect(listSessions()).toEqual([]);
  });

  it("handles sessions with missing pid", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "cnog-builder::/home/user\n",
      stderr: "",
      error: undefined,
    });

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].pid).toBeNull();
    expect(sessions[0].workingDir).toBe("/home/user");
  });
});

describe("isSessionAlive", () => {
  it("returns true when session exists", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    expect(isSessionAlive("cnog-builder")).toBe(true);
  });

  it("returns false when session does not exist", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "session not found",
      error: undefined,
    });

    expect(isSessionAlive("cnog-missing")).toBe(false);
  });
});

describe("getPanePid", () => {
  it("returns pid when pane exists", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "42\n",
      stderr: "",
      error: undefined,
    });

    expect(getPanePid("cnog-builder")).toBe(42);
  });

  it("returns null when session does not exist", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "session not found",
      error: undefined,
    });

    expect(getPanePid("cnog-missing")).toBeNull();
  });
});

describe("spawnSession", () => {
  it("calls correct tmux commands with default command", () => {
    // First call: new-session
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    // Second call: list-panes (for getPanePid)
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "9999\n",
      stderr: "",
      error: undefined,
    });

    const pid = spawnSession("cnog-builder", "/tmp/work");

    expect(pid).toBe(9999);

    // Verify the new-session call
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "new-session",
        "-d",
        "-s",
        "cnog-builder",
        "-c",
        "/tmp/work",
        "claude --dangerously-skip-permissions",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("calls tmux with custom command", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "1234\n",
      stderr: "",
      error: undefined,
    });

    spawnSession("cnog-planner", "/tmp/work", "bash");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "new-session",
        "-d",
        "-s",
        "cnog-planner",
        "-c",
        "/tmp/work",
        "bash",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns null when session creation fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "duplicate session",
      error: undefined,
    });

    expect(spawnSession("cnog-builder", "/tmp")).toBeNull();
  });
});

describe("sendKeys", () => {
  it("sends keys with Enter by default", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    const result = sendKeys("cnog-builder", "echo hello");
    expect(result).toBe(true);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "send-keys",
        "-t",
        "cnog-builder",
        "echo hello",
        "Enter",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("sends keys without Enter when enter=false", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    sendKeys("cnog-builder", "partial text", false);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "send-keys",
        "-t",
        "cnog-builder",
        "partial text",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

describe("killSession", () => {
  it("returns true on success", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    expect(killSession("cnog-builder")).toBe(true);
  });

  it("returns false on failure", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "session not found",
      error: undefined,
    });

    expect(killSession("cnog-missing")).toBe(false);
  });
});

describe("capturePane", () => {
  it("returns captured output", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "line1\nline2\nline3\n",
      stderr: "",
      error: undefined,
    });

    expect(capturePane("cnog-builder")).toBe("line1\nline2\nline3\n");
  });

  it("returns null on failure", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "session not found",
      error: undefined,
    });

    expect(capturePane("cnog-missing")).toBeNull();
  });

  it("passes custom line count", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "output",
      stderr: "",
      error: undefined,
    });

    capturePane("cnog-builder", 100);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "capture-pane",
        "-t",
        "cnog-builder",
        "-p",
        "-S-100",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

describe("pipePaneToFile", () => {
  it("configures tmux pipe-pane for transcript capture", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    expect(pipePaneToFile("cnog-builder", "/tmp/cnog/builder auth.log")).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "pipe-pane",
        "-o",
        "-t",
        "cnog-builder",
        "cat >> '/tmp/cnog/builder auth.log'",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns false when pipe-pane fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "session not found",
      error: undefined,
    });

    expect(pipePaneToFile("cnog-missing", "/tmp/missing.log")).toBe(false);
  });
});

describe("pipePaneToFiles", () => {
  it("configures tmux pipe-pane with tee for multiple task sinks", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    expect(pipePaneToFiles("cnog-builder", ["/tmp/transcript.log", "/tmp/task.output"])).toBe(true);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "tmux",
      [
        "-L",
        TMUX_SOCKET,
        "pipe-pane",
        "-o",
        "-t",
        "cnog-builder",
        "tee -a '/tmp/transcript.log' '/tmp/task.output' >/dev/null",
      ],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });
});

describe("sessionNameFor", () => {
  it("formats session name correctly", () => {
    expect(sessionNameFor("builder")).toBe("cnog-builder");
  });

  it("handles compound agent names", () => {
    expect(sessionNameFor("resolver-auth")).toBe("cnog-resolver-auth");
  });
});
