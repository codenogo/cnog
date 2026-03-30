import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { openDb, buildContext } from "../src/commands/context.js";
import { CNOG_DIR, DB_PATH } from "../src/paths.js";

describe.sequential("command context root resolution", () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-context-test-"));
    originalCwd = process.cwd();
    mkdirSync(join(tmpDir, CNOG_DIR), { recursive: true });
    const db = new CnogDB(join(tmpDir, DB_PATH));
    db.close();
    mkdirSync(join(tmpDir, CNOG_DIR, "worktrees", "agent", "src"), { recursive: true });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds the shared .cnog directory from inside an agent worktree", () => {
    process.chdir(join(tmpDir, CNOG_DIR, "worktrees", "agent", "src"));

    const db = openDb();
    const ctx = buildContext(db);

    expect(ctx.projectRoot).toBe(realpathSync(tmpDir));

    db.close();
  });
});
