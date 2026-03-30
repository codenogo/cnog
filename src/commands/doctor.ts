import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

import { buildDoctorChecks } from "../doctor.js";
import { CNOG_DIR, findProjectRoot } from "../paths.js";
import { openDb, buildContext } from "./context.js";

export function doctorCommand(): void {
  const projectRoot = findProjectRoot();
  const initialized = existsSync(join(projectRoot, CNOG_DIR));

  if (!initialized) {
    const checks = buildDoctorChecks({ projectRoot, initialized: false });
    for (const check of checks) {
      const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} [${check.category}] ${check.name}: ${check.detail}`);
    }
    return;
  }

  const db = openDb();
  try {
    const ctx = buildContext(db);
    const checks = buildDoctorChecks({
      projectRoot: ctx.projectRoot,
      initialized: true,
      config: ctx.config,
      db: ctx.db,
      watchdog: ctx.watchdog,
    });

    for (const check of checks) {
      const icon = check.ok ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} [${check.category}] ${check.name}: ${check.detail}`);
    }
  } finally {
    db.close();
  }
}
