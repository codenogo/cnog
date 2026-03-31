import { spawn } from "node:child_process";
import { openSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import chalk from "chalk";

import { writePidFile, removePidFile, isOrchestratorRunning, readPidFile } from "../config.js";
import { findProjectRoot, CNOG_DIR, LOG_FILE } from "../paths.js";

function daemonScript(): string {
  // Resolve the compiled daemon.js relative to this file
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return resolve(thisDir, "..", "daemon.js");
}

export function startCommand(): void {
  const projectRoot = findProjectRoot();

  if (isOrchestratorRunning(projectRoot)) {
    console.log(chalk.yellow(`Orchestrator already running (PID: ${readPidFile(projectRoot)})`));
    return;
  }

  // --foreground: run in this process (for debugging or systemd)
  if (process.argv.includes("--foreground")) {
    console.log(chalk.green(`Orchestrator starting in foreground (PID: ${process.pid})...`));
    // Dynamic import to avoid loading the full dependency graph until needed
    import("../daemon.js");
    return;
  }

  const script = daemonScript();
  if (!existsSync(script)) {
    console.error(chalk.red(`Daemon script not found: ${script}`));
    console.error(chalk.yellow("Run: npm run build"));
    process.exitCode = 1;
    return;
  }

  // Open log file for daemon stdout/stderr
  const logPath = join(projectRoot, LOG_FILE);
  const logFd = openSync(logPath, "a");

  // Spawn the daemon as a fully detached background process
  const child = spawn(process.execPath, [script, projectRoot], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: projectRoot,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "production" },
  });

  child.unref();

  // Wait for the daemon to write its PID file (up to 5 seconds)
  let waited = 0;
  const interval = 100;
  const maxWait = 5000;

  const check = setInterval(() => {
    waited += interval;
    const pid = readPidFile(projectRoot);

    if (pid !== null) {
      clearInterval(check);
      console.log(chalk.green(`Orchestrator started (PID: ${pid})`));
      console.log(chalk.gray(`  Log: ${logPath}`));
      console.log(chalk.gray(`  Stop: cnog stop`));
      return;
    }

    if (waited >= maxWait) {
      clearInterval(check);
      console.error(chalk.red("Orchestrator failed to start within 5 seconds."));
      console.error(chalk.yellow(`  Check log: ${logPath}`));
      process.exitCode = 1;
    }
  }, interval);
}

export function stopCommand(): void {
  const projectRoot = findProjectRoot();
  const pid = readPidFile(projectRoot);

  if (pid === null) {
    console.log(chalk.yellow("No orchestrator running."));
    return;
  }

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, "SIGTERM");
    console.log(chalk.green(`Stopping orchestrator (PID: ${pid})...`));

    // Wait for it to actually exit (up to 10 seconds)
    let waited = 0;
    const interval = 200;
    const maxWait = 10000;

    const check = setInterval(() => {
      waited += interval;

      try {
        process.kill(pid, 0); // Check if still alive
      } catch {
        // Process exited
        clearInterval(check);
        removePidFile(projectRoot);
        console.log(chalk.green("Orchestrator stopped."));
        return;
      }

      if (waited >= maxWait) {
        clearInterval(check);
        // Force kill
        try {
          process.kill(pid, "SIGKILL");
        } catch { /* already dead */ }
        removePidFile(projectRoot);
        console.log(chalk.yellow(`Orchestrator force-killed after ${maxWait / 1000}s timeout.`));
      }
    }, interval);
  } catch {
    removePidFile(projectRoot);
    console.log(chalk.yellow(`Orchestrator PID ${pid} not found. Cleaned up stale PID file.`));
  }
}

export function logsCommand(): void {
  const projectRoot = findProjectRoot();
  const logPath = join(projectRoot, LOG_FILE);

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
