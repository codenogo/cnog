/**
 * Dependency injection container for CLI commands.
 *
 * Creates all services once, shared across commands in a session.
 * Avoids re-instantiating the full dependency graph per command.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { CnogDB } from "../db.js";
import { EventEmitter } from "../events.js";
import { MailClient } from "../mail.js";
import { MemoryEngine } from "../memory.js";
import { Lifecycle } from "../lifecycle.js";
import { AgentManager } from "../agents.js";
import { MergeQueue } from "../merge.js";
import { Watchdog } from "../watchdog.js";
import { Dispatcher } from "../dispatch.js";
import { ExecutionEngine } from "../execution.js";
import { ContractManager } from "../contracts.js";
import { CnogError } from "../errors.js";
import { loadConfig, resolveConfigProjectRoot, type CnogConfig } from "../config.js";
import { CNOG_DIR, DB_PATH, findProjectRoot } from "../paths.js";

export interface CommandContext {
  db: CnogDB;
  projectRoot: string;
  config: CnogConfig;
  events: EventEmitter;
  mail: MailClient;
  memory: MemoryEngine;
  lifecycle: Lifecycle;
  agents: AgentManager;
  mergeQueue: MergeQueue;
  watchdog: Watchdog;
  dispatcher: Dispatcher;
  execution: ExecutionEngine;
  contracts: ContractManager;
}

/**
 * Open the database, or throw NOT_INITIALIZED.
 */
export function openDb(): CnogDB {
  const projectRoot = findProjectRoot();
  if (!existsSync(join(projectRoot, CNOG_DIR))) {
    throw new CnogError("NOT_INITIALIZED");
  }
  return new CnogDB(join(projectRoot, DB_PATH));
}

/**
 * Run a function with a database connection that auto-closes.
 */
export function withDb<T>(fn: (db: CnogDB) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Build the full command context (all services wired together).
 */
export function buildContext(db?: CnogDB): CommandContext {
  const database = db ?? openDb();
  const discoveredRoot = findProjectRoot();
  const config = loadConfig(discoveredRoot);
  const root = resolveConfigProjectRoot(discoveredRoot, config);
  const events = new EventEmitter(database);
  const mail = new MailClient(database);
  const memory = new MemoryEngine(database);
  const lifecycle = new Lifecycle(database, events, root);
  const agents = new AgentManager(database, events, root, "agents", config.worktree);
  const mergeQueue = new MergeQueue(
    database,
    events,
    config.project.canonicalBranch,
    root,
    lifecycle,
  );
  const watchdog = new Watchdog(
    database,
    events,
    mail,
    config.watchdog.staleThresholdMs,
    config.watchdog.zombieThresholdMs,
    undefined,
    root,
  );
  const dispatcher = new Dispatcher(database, lifecycle, memory, events, root);
  const execution = new ExecutionEngine(
    database,
    agents,
    lifecycle,
    memory,
    mergeQueue,
    events,
    dispatcher,
    config.agents.runtime,
    config.project.canonicalBranch,
    root,
    config.worktree,
  );
  const contracts = new ContractManager(database, events, root);

  return {
    db: database,
    projectRoot: root,
    config,
    events,
    mail,
    memory,
    lifecycle,
    agents,
    mergeQueue,
    watchdog,
    dispatcher,
    execution,
    contracts,
  };
}
