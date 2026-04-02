#!/usr/bin/env node
/**
 * Orchestrator daemon process.
 *
 * This module exposes an explicit `runDaemon()` entry point so both
 * foreground and detached startup use the same root resolution and
 * lifecycle wiring.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CnogDB } from "./db.js";
import { EventEmitter } from "./events.js";
import { MailClient } from "./mail.js";
import { MergeQueue } from "./merge.js";
import { Watchdog } from "./watchdog.js";
import { Lifecycle } from "./lifecycle.js";
import { Orchestrator } from "./orchestrator.js";
import {
  loadConfig,
  resolveConfigProjectRoot,
  writePidFile,
  removePidFile,
} from "./config.js";
import { DB_PATH, CNOG_DIR, LOG_FILE } from "./paths.js";

// Lazy import to avoid circular dependency at module level.
async function loadExecution() {
  const { ExecutionEngine } = await import("./execution.js");
  return ExecutionEngine;
}

export interface DaemonArgs {
  cnogRoot: string;
  foreground: boolean;
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  let cnogRoot: string | null = null;
  let foreground = false;

  for (const arg of argv) {
    if (arg === "--foreground") {
      foreground = true;
      continue;
    }
    if (!arg.startsWith("-") && cnogRoot === null) {
      cnogRoot = arg;
    }
  }

  return {
    cnogRoot: resolve(cnogRoot ?? process.cwd()),
    foreground,
  };
}

export async function runDaemon(
  cnogRoot: string,
  opts: { foreground?: boolean } = {},
): Promise<void> {
  const foreground = opts.foreground ?? false;

  const logDir = join(cnogRoot, CNOG_DIR);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logPath = join(cnogRoot, LOG_FILE);
  const logStream = createWriteStream(logPath, { flags: "a" });

  let db: CnogDB | null = null;
  let orch: Orchestrator | null = null;
  let shuttingDown = false;

  function log(level: string, msg: string): void {
    const ts = new Date().toISOString();
    const line = `${ts} [${level}] ${msg}\n`;
    logStream.write(line);
    if (foreground) {
      process.stdout.write(line);
    }
  }

  function cleanup(code: number = 0): void {
    if (shuttingDown) return;
    shuttingDown = true;

    log("INFO", "Shutting down...");
    try {
      orch?.stop();
    } catch { /* ignore */ }
    try {
      db?.close();
    } catch { /* ignore */ }
    try {
      removePidFile(cnogRoot);
    } catch { /* ignore */ }
    logStream.end(() => {
      process.exit(code);
    });
  }

  process.on("uncaughtException", (err) => {
    log("FATAL", `Uncaught exception: ${err.stack ?? err.message}`);
    cleanup(1);
  });

  process.on("unhandledRejection", (reason) => {
    log("FATAL", `Unhandled rejection: ${reason}`);
    cleanup(1);
  });

  const dbPath = join(cnogRoot, DB_PATH);
  if (!existsSync(dbPath)) {
    log("ERROR", `Database not found at ${dbPath}. Run: cnog init`);
    cleanup(1);
    return;
  }

  db = new CnogDB(dbPath);
  const config = loadConfig(cnogRoot);
  const projectRoot = resolveConfigProjectRoot(cnogRoot, config);
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
    undefined,
    projectRoot,
  );

  let execution: InstanceType<Awaited<ReturnType<typeof loadExecution>>> | undefined;

  orch = new Orchestrator(
    db,
    events,
    mail,
    mergeQueue,
    watchdog,
    lifecycle,
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

  process.on("SIGTERM", () => {
    log("INFO", "Received SIGTERM");
    cleanup(0);
  });

  process.on("SIGINT", () => {
    log("INFO", "Received SIGINT");
    cleanup(0);
  });

  process.on("exit", () => {
    try { removePidFile(cnogRoot); } catch { /* ignore */ }
  });

  try {
    const ExecClass = await loadExecution();
    const { AgentManager } = await import("./agents.js");
    const { MemoryEngine } = await import("./memory.js");
    const { Dispatcher } = await import("./dispatch.js");

    const agents = new AgentManager(db, events, projectRoot, "agents", config.worktree);
    const memory = new MemoryEngine(db);
    const dispatcher = new Dispatcher(db, lifecycle, memory, events, projectRoot);

    execution = new ExecClass(
      db,
      agents,
      lifecycle,
      memory,
      mergeQueue,
      events,
      dispatcher,
      config.agents.runtime,
      config.project.canonicalBranch,
      projectRoot,
      config.worktree,
    );
    log("INFO", "Execution engine initialized");
  } catch (err) {
    log("WARN", `Execution engine not available: ${err}. Running in coordination-only mode.`);
  }

  writePidFile(cnogRoot);
  log("INFO", `Daemon started (PID: ${process.pid}, cnogRoot: ${cnogRoot}, projectRoot: ${projectRoot})`);
  log("INFO", `Orchestrator starting (tick: ${config.orchestrator.tickIntervalMs}ms, wip: ${config.orchestrator.maxWip})`);
  orch.start();
  log("INFO", "Orchestrator running");
}

async function main(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));
  await runDaemon(args.cnogRoot, { foreground: args.foreground });
}

function isExecutedDirectly(): boolean {
  const entry = process.argv[1];
  return !!entry && import.meta.url === pathToFileURL(entry).href;
}

if (isExecutedDirectly()) {
  main().catch((err) => {
    process.stderr.write(`Fatal daemon error: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
