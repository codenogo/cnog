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
  sanitizeWorktreeSegment,
  validateWorktreeSegment,
  WORKTREE_BASE,
} from "../src/worktree.js";

beforeEach(() => {
  mockSpawnSync.mockReset();
});

describe("sanitizeWorktreeSegment", () => {
  it("keeps already safe names readable", () => {
    expect(sanitizeWorktreeSegment("builder-auth")).toBe("builder-auth");
    expect(sanitizeWorktreeSegment("feature.v2")).toBe("feature.v2");
  });

  it("disambiguates case-only variants so they do not reuse the same slug", () => {
    const canonical = sanitizeWorktreeSegment("auth");
    const caseVariant = sanitizeWorktreeSegment("Auth");

    expect(canonical).toBe("auth");
    expect(caseVariant).toMatch(/^auth-[a-f0-9]{8}$/);
    expect(caseVariant).not.toBe(canonical);
  });

  it("disambiguates normalization-equivalent variants so they do not collide", () => {
    const precomposed = sanitizeWorktreeSegment("Cafe\u00E9");
    const decomposed = sanitizeWorktreeSegment("Cafee\u0301");

    expect(precomposed).toMatch(/^cafe-[a-f0-9]{8}$/);
    expect(decomposed).toMatch(/^cafe-[a-f0-9]{8}$/);
    expect(precomposed).not.toBe(decomposed);
  });

  it("flattens slash-separated names into a safe deterministic slug", () => {
    const slug = sanitizeWorktreeSegment("team/payments");
    expect(slug).toMatch(/^team\+payments-[a-f0-9]{8}$/);
    expect(slug).not.toContain("/");
  });

  it("rejects path traversal", () => {
    expect(() => validateWorktreeSegment("../escape")).toThrow("path traversal");
    expect(() => validateWorktreeSegment("safe/../escape")).toThrow("path traversal");
  });
});

describe("branchName", () => {
  it("formats branch name correctly", () => {
    expect(branchName("auth", "builder")).toBe("cnog/auth/builder");
  });

  it("sanitizes feature and agent names", () => {
    const featureSlug = sanitizeWorktreeSegment("team/auth");
    const agentSlug = sanitizeWorktreeSegment("builder/team-a");
    expect(branchName("team/auth", "builder/team-a")).toBe(`cnog/${featureSlug}/${agentSlug}`);
  });
});

describe("worktreePath", () => {
  it("generates correct path with project root", () => {
    const agentSlug = sanitizeWorktreeSegment("builder");
    const result = worktreePath("builder", "/home/user/project");
    expect(result).toBe(`/home/user/project/${WORKTREE_BASE}/${agentSlug}`);
  });

  it("uses sanitized agent names in the path", () => {
    const agentSlug = sanitizeWorktreeSegment("builder/team-a");
    const result = worktreePath("builder/team-a", "/repo");
    expect(result).toBe(`/repo/${WORKTREE_BASE}/${agentSlug}`);
  });
});

describe("_git", () => {
  it("runs git commands successfully with no-prompt env", () => {
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
      expect.objectContaining({
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          GIT_EDITOR: "true",
        }),
      }),
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
  it("calls git worktree add with -B and returns a fresh worktree", () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "",
        stderr: "",
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "",
        stderr: "",
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "",
        stderr: "",
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "abc123def456\n",
        stderr: "",
        error: undefined,
      });

    const result = create("builder", "auth", "main", "/home/user/project");

    expect(result.branch).toBe("cnog/auth/builder");
    expect(result.head).toBe("abc123def456");
    expect(result.path).toBe(`/home/user/project/${WORKTREE_BASE}/builder`);
    expect(result.existed).toBe(false);

    const addCall = mockSpawnSync.mock.calls[2];
    expect(addCall[0]).toBe("git");
    expect(addCall[1]).toEqual([
      "worktree",
      "add",
      "-B",
      "cnog/auth/builder",
      `/home/user/project/${WORKTREE_BASE}/builder`,
      "main",
    ]);
  });

  it("resumes an existing registered worktree instead of recreating it", () => {
    const existingPath = `/home/user/project/${WORKTREE_BASE}/builder`;
    const porcelainOutput = [
      `worktree ${existingPath}`,
      "HEAD abc123",
      "branch refs/heads/cnog/auth/builder",
      "",
    ].join("\n");

    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "",
        stderr: "",
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: porcelainOutput,
        stderr: "",
        error: undefined,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "abc123\n",
        stderr: "",
        error: undefined,
      });

    const result = create("builder", "auth", "main", "/home/user/project");

    expect(result.existed).toBe(true);
    expect(result.path).toBe(existingPath);
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);
    expect(mockSpawnSync.mock.calls[2][1]).toEqual(["rev-parse", "HEAD"]);
  });

  it("configures sparse checkout when sparse paths are provided", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "abc123\n", stderr: "", error: undefined });

    const result = create("builder", "auth", "main", "/tmp/project", {
      sparsePaths: ["src", "tests/unit"],
    });

    expect(result.existed).toBe(false);
    expect(mockSpawnSync.mock.calls[2][1]).toEqual([
      "worktree",
      "add",
      "--no-checkout",
      "-B",
      "cnog/auth/builder",
      `/tmp/project/${WORKTREE_BASE}/builder`,
      "main",
    ]);
    expect(mockSpawnSync.mock.calls[3][1]).toEqual([
      "sparse-checkout",
      "set",
      "--cone",
      "--",
      "src",
      "tests/unit",
    ]);
    expect(mockSpawnSync.mock.calls[4][1]).toEqual(["checkout", "HEAD"]);
  });

  it("throws when worktree creation fails", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({
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
    mockSpawnSync
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "", error: undefined })
      .mockReturnValueOnce({
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
    expect(worktrees[0]).toMatchObject({
      path: "/home/user/project",
      branch: "refs/heads/main",
      head: "abc123",
      existed: true,
    });
    expect(worktrees[1]).toMatchObject({
      path: "/home/user/project/.cnog/worktrees/builder",
      branch: "refs/heads/cnog/auth/builder",
      head: "def456",
      existed: true,
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
