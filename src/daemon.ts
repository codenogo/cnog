#!/usr/bin/env node
/**
 * Orchestrator daemon process.
 *
 * Spawned by `cnog start` as a detached background process.
 * Handles: logging, PID management, signal handling, graceful shutdown.
 *
 * Usage:
 *   node daemon.js <project-root>
 *   node daemon.js <project-root> --foreground
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { CnogDB } from "./db.js";
import { EventEmitter } from "./events.js";
import { MailClient } from "./mail.js";
import { MergeQueue } from "./merge.js";
import { Watchdog } from "./watchdog.js";
import { Lifecycle } from "./lifecycle.js";
import { Orchestrator } from "./orchestrator.js";
import { loadConfig, writePidFile, removePidFile } from "./config.js";
import { DB_PATH, CNOG_DIR, LOG_FILE } from "./paths.js";

// Lazy import to avoid circular dependency at module level
async function loadExecution() {
  const { ExecutionEngine } = await import("./execution.js");
  return ExecutionEngine;
}

const projectRoot = resolve(process.argv[2] ?? process.cwd());
const foreground = process.argv.includes("--foreground");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logDir = join(projectRoot, CNOG_DIR);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const logPath = join(projectRoot, LOG_FILE);
const logStream = createWriteStream(logPath, { flags: "a" });

function log(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}\n`;
  logStream.write(line);
  if (foreground) {
    process.stdout.write(line);
  }
}

// Redirect uncaught errors to log
process.on("uncaughtException", (err) => {
  log("FATAL", `Uncaught exception: ${err.stack ?? err.message}`);
  cleanup(1);
});

process.on("unhandledRejection", (reason) => {
  log("FATAL", `Unhandled rejection: ${reason}`);
  cleanup(1);
});

// ---------------------------------------------------------------------------
// PID management
// ---------------------------------------------------------------------------

writePidFile(projectRoot);
log("INFO", `Daemon started (PID: ${process.pid}, project: ${projectRoot})`);

// ---------------------------------------------------------------------------
// Orchestrator setup
// ---------------------------------------------------------------------------

const dbPath = join(projectRoot, DB_PATH);
if (!existsSync(dbPath)) {
  log("ERROR", `Database not found at ${dbPath}. Run: cnog init`);
  cleanup(1);
}

const db = new CnogDB(dbPath);
const config = loadConfig(projectRoot);
const events = new EventEmitter(db);
const mail = new MailClient(db);
const lifecycle = new Lifecycle(db, events, projectRoot);
const mergeQueue = new MergeQueue(
  db,
  events,
  config.project.canonicalBranch,
  projectRoot,
  lifecycle,
);
const watchdog = new Watchdog(
  db,
  events,
  mail,
  config.watchdog.staleThresholdMs,
  config.watchdog.zombieThresholdMs,
);

let execution: InstanceType<Awaited<ReturnType<typeof loadExecution>>> | undefined;

const orch = new Orchestrator(
  db, events, mail, mergeQueue, watchdog, lifecycle,
  {
    dbPath: DB_PATH,
    projectRoot,
    agentsDir: "agents",
    canonicalBranch: config.project.canonicalBranch,
    tickInterval: config.orchestrator.tickIntervalMs,
    maxWip: config.orchestrator.maxWip,
    staleThreshold: config.watchdog.staleThresholdMs,
    zombieThreshold: config.watchdog.zombieThresholdMs,
  },
  {
    get execution() { return execution; },
  },
);

// ---------------------------------------------------------------------------
// Signal handling + graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

function cleanup(code: number = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log("INFO", "Shutting down...");
  orch.stop();
  db.close();
  removePidFile(projectRoot);
  logStream.end(() => {
    process.exit(code);
  });
}

process.on("SIGTERM", () => {
  log("INFO", "Received SIGTERM");
  cleanup(0);
});

process.on("SIGINT", () => {
  log("INFO", "Received SIGINT");
  cleanup(0);
});

process.on("exit", () => {
  // Last-resort PID cleanup if we didn't go through cleanup()
  try { removePidFile(projectRoot); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  try {
    const ExecClass = await loadExecution();
    const { AgentManager } = await import("./agents.js");
    const { MemoryEngine } = await import("./memory.js");
    const { Dispatcher } = await import("./dispatch.js");

    const agents = new AgentManager(db, events, projectRoot);
    const memory = new MemoryEngine(db);
    const dispatcher = new Dispatcher(db, lifecycle, memory, events, projectRoot);

    execution = new ExecClass(
      db, agents, lifecycle, memory, mergeQueue, events, dispatcher,
      config.agents.runtime, config.project.canonicalBranch, projectRoot,
    );
    log("INFO", "Execution engine initialized");
  } catch (err) {
    log("WARN", `Execution engine not available: ${err}. Running in coordination-only mode.`);
  }

  log("INFO", `Orchestrator starting (tick: ${config.orchestrator.tickIntervalMs}ms, wip: ${config.orchestrator.maxWip})`);
  orch.start();
  log("INFO", "Orchestrator running");
}

main().catch((err) => {
  log("FATAL", `Failed to start: ${err.stack ?? err.message}`);
  cleanup(1);
});
