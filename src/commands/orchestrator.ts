import chalk from "chalk";

import { Orchestrator } from "../orchestrator.js";
import { writePidFile, removePidFile, isOrchestratorRunning, readPidFile } from "../config.js";
import { buildContext, openDb } from "./context.js";
import { DB_PATH } from "../paths.js";

export function startCommand(): void {
  if (isOrchestratorRunning()) {
    console.log(chalk.yellow("Orchestrator already running (PID: " + readPidFile() + ")"));
    return;
  }

  const db = openDb();
  const ctx = buildContext(db);
  const orch = new Orchestrator(
    ctx.db, ctx.events, ctx.mail, ctx.mergeQueue, ctx.watchdog, ctx.lifecycle,
    {
      dbPath: DB_PATH,
      projectRoot: ctx.projectRoot,
      agentsDir: "agents",
      canonicalBranch: ctx.config.project.canonicalBranch,
      tickInterval: ctx.config.orchestrator.tickIntervalMs,
      maxWip: ctx.config.orchestrator.maxWip,
      staleThreshold: ctx.config.watchdog.staleThresholdMs,
      zombieThreshold: ctx.config.watchdog.zombieThresholdMs,
    },
    {
      execution: ctx.execution,
    },
  );

  writePidFile();
  console.log(chalk.green(`Orchestrator starting (PID: ${process.pid})...`));
  process.on("exit", () => removePidFile());
  orch.start();
}

export function stopCommand(): void {
  const pid = readPidFile();
  if (pid === null) {
    console.log(chalk.yellow("No orchestrator running."));
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    removePidFile();
    console.log(chalk.green(`Stopped orchestrator (PID: ${pid})`));
  } catch {
    removePidFile();
    console.log(chalk.yellow(`Orchestrator PID ${pid} not found. Cleaned up stale PID file.`));
  }
}
