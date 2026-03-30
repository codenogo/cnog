import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";

import { CnogDB } from "../db.js";
import { writeDefaultConfig } from "../config.js";
import { _git } from "../worktree.js";
import { CNOG_DIR, DB_PATH } from "../paths.js";

export function initCommand(opts: { force: boolean }): void {
  const gitCheck = _git("rev-parse", "--git-dir");
  if (gitCheck.status !== 0) {
    console.log(chalk.red("Not a git repository. Run this inside a git repo."));
    return;
  }

  if (existsSync(CNOG_DIR) && !opts.force) {
    console.log(chalk.yellow("Already initialized. Use --force to reinitialize."));
    return;
  }

  mkdirSync(CNOG_DIR, { recursive: true });
  mkdirSync(resolve(CNOG_DIR, "worktrees"), { recursive: true });
  mkdirSync(resolve(CNOG_DIR, "agents"), { recursive: true });
  mkdirSync(resolve(CNOG_DIR, "contracts"), { recursive: true });
  mkdirSync(resolve(CNOG_DIR, "reviews"), { recursive: true });
  const db = new CnogDB(DB_PATH);
  db.close();
  writeDefaultConfig();
  console.log(chalk.green("cnog initialized."));
  console.log(`  Config: .cnog/config.yaml`);
  console.log(`  Database: ${DB_PATH}`);
}
