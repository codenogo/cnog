import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { CnogError } from "../errors.js";
import { runDaemon } from "../daemon.js";
import { removePidFile, isOrchestratorRunning, readPidFile } from "../config.js";
import { findProjectRoot, CNOG_DIR, LOG_FILE } from "../paths.js";

function daemonScript(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "daemon.js");
}

function ensureInitialized(cnogRoot: string): void {
  if (!existsSync(join(cnogRoot, CNOG_DIR))) {
    throw new CnogError("NOT_INITIALIZED");
  }
}

function sleepMs(ms: number): void {
  spawnSync("sleep", [String(ms / 1000)]);
}

export function startCommand(opts: { foreground?: boolean } = {}): boolean {
  const cnogRoot = findProjectRoot();
  ensureInitialized(cnogRoot);

  if (isOrchestratorRunning(cnogRoot)) {
    console.log(chalk.yellow(`Orchestrator already running (PID: ${readPidFile(cnogRoot)})`));
    return true;
  }

  if (opts.foreground) {
    console.log(chalk.green(`Orchestrator starting in foreground (PID: ${process.pid})...`));
    void runDaemon(cnogRoot, { foreground: true }).catch((err) => {
      console.error(chalk.red(`Failed to start orchestrator: ${err instanceof Error ? err.message : String(err)}`));
      process.exitCode = 1;
    });
    return true;
  }

  const script = daemonScript();
  if (!existsSync(script)) {
    console.error(chalk.red(`Daemon script not found: ${script}`));
    console.error(chalk.yellow("Run: npm run build"));
    process.exitCode = 1;
    return false;
  }

  const logPath = join(cnogRoot, LOG_FILE);
  const logFd = openSync(logPath, "a");

  try {
    const child = spawn(process.execPath, [script, cnogRoot], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: cnogRoot,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  const interval = 100;
  const maxWait = 5000;
  for (let waited = 0; waited < maxWait; waited += interval) {
    const pid = readPidFile(cnogRoot);
    if (pid !== null) {
      console.log(chalk.green(`Orchestrator started (PID: ${pid})`));
      console.log(chalk.gray(`  Log: ${logPath}`));
      console.log(chalk.gray("  Stop: cnog stop"));
      return true;
    }
    sleepMs(interval);
  }

  console.error(chalk.red("Orchestrator failed to start within 5 seconds."));
  console.error(chalk.yellow(`  Check log: ${logPath}`));
  process.exitCode = 1;
  return false;
}

export function stopCommand(): void {
  const cnogRoot = findProjectRoot();
  ensureInitialized(cnogRoot);

  const pid = readPidFile(cnogRoot);
  if (pid === null) {
    console.log(chalk.yellow("No orchestrator running."));
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Stopping orchestrator (PID: ${pid})...`));
  } catch {
    removePidFile(cnogRoot);
    console.log(chalk.yellow(`Orchestrator PID ${pid} not found. Cleaned up stale PID file.`));
    return;
  }

  const interval = 200;
  const maxWait = 10000;
  for (let waited = 0; waited < maxWait; waited += interval) {
    sleepMs(interval);
    try {
      process.kill(pid, 0);
    } catch {
      removePidFile(cnogRoot);
      console.log(chalk.green("Orchestrator stopped."));
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch { /* already dead */ }
  removePidFile(cnogRoot);
  console.log(chalk.yellow(`Orchestrator force-killed after ${maxWait / 1000}s timeout.`));
}

export function logsCommand(): void {
  const cnogRoot = findProjectRoot();
  ensureInitialized(cnogRoot);

  const logPath = join(cnogRoot, LOG_FILE);
  if (!existsSync(logPath)) {
    console.log(chalk.gray("No orchestrator log file found."));
    return;
  }

  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n");
  const tail = lines.slice(-50);
  for (const line of tail) {
    if (line.includes("[ERROR]") || line.includes("[FATAL]")) {
      console.log(chalk.red(line));
    } else if (line.includes("[WARN]")) {
      console.log(chalk.yellow(line));
    } else {
      console.log(line);
    }
  }
}
