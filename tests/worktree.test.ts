import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const mockSpawnSync = spawnSync as ReturnType<typeof vi.fn>;

import {
  _git,
  branchName,
  worktreePath,
  create,
  remove,
  deleteBranch,
  listWorktrees,
  prune,
  WORKTREE_BASE,
} from "../src/worktree.js";

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe("branchName", () => {
  it("formats branch name correctly", () => {
    expect(branchName("auth", "builder")).toBe("cnog/auth/builder");
  });

  it("handles feature names with hyphens", () => {
    expect(branchName("user-auth", "agent-1")).toBe(
      "cnog/user-auth/agent-1",
    );
  });
});

describe("worktreePath", () => {
  it("generates correct path with project root", () => {
    const result = worktreePath("builder", "/home/user/project");
    expect(result).toBe(`/home/user/project/${WORKTREE_BASE}/builder`);
  });

  it("uses cwd when no project root provided", () => {
    const result = worktreePath("builder");
    expect(result).toContain(`${WORKTREE_BASE}/builder`);
  });
});

describe("_git", () => {
  it("runs git commands successfully", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "output",
      stderr: "",
      error: undefined,
    });

    const result = _git("status");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["status"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("output");
  });

  it("runs git commands with cwd option", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "output",
      stderr: "",
      error: undefined,
    });

    _git({ cwd: "/tmp" }, "log");

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["log"],
      expect.objectContaining({ encoding: "utf-8", cwd: "/tmp" }),
    );
  });

  it("throws CnogError when git is not available", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });

    expect(() => _git("status")).toThrow("git is not installed");
  });
});

describe("create", () => {
  it("calls git worktree add with correct args", () => {
    // First call: worktree add
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    // Second call: rev-parse HEAD
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc123def456\n",
      stderr: "",
      error: undefined,
    });

    const result = create("builder", "auth", "main", "/home/user/project");

    expect(result.branch).toBe("cnog/auth/builder");
    expect(result.head).toBe("abc123def456");
    expect(result.path).toBe(
      `/home/user/project/${WORKTREE_BASE}/builder`,
    );

    // Verify worktree add call
    const firstCall = mockSpawnSync.mock.calls[0];
    expect(firstCall[0]).toBe("git");
    expect(firstCall[1]).toContain("worktree");
    expect(firstCall[1]).toContain("add");
    expect(firstCall[1]).toContain("-b");
    expect(firstCall[1]).toContain("cnog/auth/builder");
    expect(firstCall[1]).toContain("main");
  });

  it("uses default base branch of main", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "abc123\n",
      stderr: "",
      error: undefined,
    });

    create("builder", "auth", undefined, "/tmp/project");

    const firstCall = mockSpawnSync.mock.calls[0];
    expect(firstCall[1]).toContain("main");
  });

  it("throws when worktree creation fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 128,
      stdout: "",
      stderr: "fatal: already exists",
      error: undefined,
    });

    expect(() => create("builder", "auth", "main", "/tmp")).toThrow(
      "Failed to create worktree",
    );
  });

  it("sets head to unknown when rev-parse fails", () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "error",
      error: undefined,
    });

    const result = create("builder", "auth", "main", "/tmp");
    expect(result.head).toBe("unknown");
  });
});

describe("remove", () => {
  it("calls git worktree remove", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    const result = remove("builder", "/home/user/project");

    expect(result).toBe(true);

    const call = mockSpawnSync.mock.calls[0];
    expect(call[0]).toBe("git");
    expect(call[1]).toContain("worktree");
    expect(call[1]).toContain("remove");
  });

  it("passes --force flag when force is true", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    remove("builder", "/home/user/project", true);

    const call = mockSpawnSync.mock.calls[0];
    expect(call[1]).toContain("--force");
  });

  it("returns false when removal fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "not a worktree",
      error: undefined,
    });

    expect(remove("builder", "/tmp")).toBe(false);
  });
});

describe("deleteBranch", () => {
  it("deletes branch without force", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    const result = deleteBranch("auth", "builder", "/tmp");

    expect(result).toBe(true);

    const call = mockSpawnSync.mock.calls[0];
    expect(call[0]).toBe("git");
    expect(call[1]).toContain("branch");
    expect(call[1]).toContain("-d");
    expect(call[1]).toContain("cnog/auth/builder");
    expect(call[1]).not.toContain("-D");
  });

  it("deletes branch with force", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    deleteBranch("auth", "builder", "/tmp", true);

    const call = mockSpawnSync.mock.calls[0];
    expect(call[1]).toContain("-D");
    expect(call[1]).not.toContain("-d");
  });

  it("returns false when branch deletion fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "error: branch not found",
      error: undefined,
    });

    expect(deleteBranch("auth", "builder", "/tmp")).toBe(false);
  });
});

describe("listWorktrees", () => {
  it("parses porcelain output correctly", () => {
    const porcelainOutput = [
      "worktree /home/user/project",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /home/user/project/.cnog/worktrees/builder",
      "HEAD def456",
      "branch refs/heads/cnog/auth/builder",
      "",
    ].join("\n");

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: porcelainOutput,
      stderr: "",
      error: undefined,
    });

    const worktrees = listWorktrees("/home/user/project");

    expect(worktrees).toHaveLength(2);
    expect(worktrees[0]).toEqual({
      path: "/home/user/project",
      branch: "refs/heads/main",
      head: "abc123",
    });
    expect(worktrees[1]).toEqual({
      path: "/home/user/project/.cnog/worktrees/builder",
      branch: "refs/heads/cnog/auth/builder",
      head: "def456",
    });
  });

  it("returns empty array when git fails", () => {
    mockSpawnSync.mockReturnValue({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      error: undefined,
    });

    expect(listWorktrees("/tmp")).toEqual([]);
  });

  it("handles porcelain output without trailing newline", () => {
    const porcelainOutput = [
      "worktree /home/user/project",
      "HEAD abc123",
      "branch refs/heads/main",
    ].join("\n");

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: porcelainOutput,
      stderr: "",
      error: undefined,
    });

    const worktrees = listWorktrees();
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path).toBe("/home/user/project");
  });
});

describe("prune", () => {
  it("calls git worktree prune", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });

    prune("/home/user/project");

    const call = mockSpawnSync.mock.calls[0];
    expect(call[0]).toBe("git");
    expect(call[1]).toContain("worktree");
    expect(call[1]).toContain("prune");
    expect(call[2]).toEqual(
      expect.objectContaining({ cwd: "/home/user/project" }),
    );
  });
});
