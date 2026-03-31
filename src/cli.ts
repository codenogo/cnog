/**
 * CLI entry point — thin yargs router.
 *
 * Each command delegates to a handler in src/commands/.
 * This file only defines the argument schema and routes to handlers.
 */

import yargs from "yargs";
import chalk from "chalk";
import { ZodError } from "zod";

import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { statusCommand } from "./commands/status.js";
import { startCommand, stopCommand, logsCommand as orchLogsCommand } from "./commands/orchestrator.js";
import {
  slingCommand, agentsListCommand, spawnCommand, stopAgentCommand,
  inspectCommand, nudgeCommand, heartbeatCommand, evaluateCommand,
} from "./commands/agents.js";
import { mailSendCommand, mailCheckCommand, mailListCommand } from "./commands/mail.js";
import { phaseGetCommand, phaseAdvanceCommand, phaseListCommand, shipCommand, runResetCommand } from "./commands/lifecycle.js";
import {
  memoryCreateCommand, memoryShowCommand, memoryListCommand,
  memoryReadyCommand, memoryClaimCommand, memoryCloseCommand, memoryStatsCommand,
} from "./commands/memory.js";
import { planCommand, shapeCommand, mergeCommand } from "./commands/planning.js";
import {
  dashboardCommand, feedCommand, logsCommand, costsCommand,
  checkpointSaveCommand, checkpointShowCommand, progressCommand, handoffsCommand,
  contractShowCommand, contractAcceptCommand, contractRejectCommand, gradeCommand,
} from "./commands/observability.js";
import { runListCommand, runShowCommand } from "./commands/lifecycle.js";
import { CnogError } from "./errors.js";

export function main(args: string[]): void {
  try {
    yargs(args)
      .scriptName("cnog")
      .version("2.0.0-alpha.1")
      .usage("$0 <command> [options]")

      // Core
      .command("init", "Initialize cnog in this project",
        (y) => y.option("force", { type: "boolean", default: false }),
        (argv) => initCommand({ force: argv.force }))

      .command("doctor", "Health check", {}, () => doctorCommand())

      .command("status", "Fleet overview",
        (y) => y.option("json", { type: "boolean", default: false }),
        (argv) => statusCommand({ json: argv.json }))

      .command("dashboard", "Live terminal dashboard", {}, () => dashboardCommand())

      // Orchestrator
      .command("start", "Start orchestrator", {}, () => startCommand())
      .command("stop", "Stop orchestrator", {}, () => stopCommand())

      // Feature workflow
      .command("sling <feature>", "Dispatch agents for a feature",
        (y) => y.positional("feature", { type: "string", demandOption: true })
          .option("profile", { type: "string" })
          .option("runtime", { type: "string" }),
        (argv) => slingCommand(argv.feature!, argv.profile, argv.runtime))

      .command("shape <feature>", "Create a feature skeleton and run",
        (y) => y.positional("feature", { type: "string", demandOption: true }),
        (argv) => shapeCommand(argv.feature!))

      .command("plan <feature>", "Show or validate plan",
        (y) => y.positional("feature", { type: "string", demandOption: true })
          .option("profile", { type: "string" }).option("json", { type: "boolean", default: false })
          .option("validate", { type: "boolean", default: false }),
        (argv) => planCommand(argv.feature!, { profile: argv.profile, json: argv.json, validate: argv.validate }))

      .command("evaluate <feature>", "Spawn evaluator agent",
        (y) => y.positional("feature", { type: "string", demandOption: true }).option("runtime", { type: "string" }),
        (argv) => evaluateCommand(argv.feature!, argv.runtime))

      .command("ship <feature>", "Ship a feature",
        (y) => y.positional("feature", { type: "string", demandOption: true }),
        (argv) => shipCommand(argv.feature!))

      .command("merge", "Process merge queue",
        (y) => y.option("feature", { type: "string" }).option("all", { type: "boolean", default: false }).option("dry-run", { type: "boolean", default: false }),
        (argv) => mergeCommand({ feature: argv.feature, all: argv.all, dryRun: argv.dryRun }))

      // Runs
      .command("run", "Run management", (y) => y
        .command("list [feature]", "List runs",
          (y2) => y2.positional("feature", { type: "string" }).option("json", { type: "boolean", default: false }),
          (argv) => runListCommand(argv.feature, { json: argv.json }))
        .command("show <run-id>", "Show run details",
          (y2) => y2.positional("run-id", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
          (argv) => runShowCommand(argv.runId!, { json: argv.json }))
        .command("reset <run-id>", "Archive and reset a run to a clean executable state",
          (y2) => y2.positional("run-id", { type: "string", demandOption: true }).option("reason", { type: "string", default: "manual_reset" }),
          (argv) => runResetCommand(argv.runId!, { reason: argv.reason }))
        .demandCommand(1))

      // Agents
      .command("agents", "List agents",
        (y) => y.option("state", { type: "string" }).option("json", { type: "boolean", default: false }),
        (argv) => agentsListCommand({ state: argv.state, json: argv.json }))

      .command("spawn <capability> <name>", "Spawn an agent manually",
        (y) => y.positional("capability", { type: "string", demandOption: true })
          .positional("name", { type: "string", demandOption: true })
          .option("task", { type: "string", demandOption: true })
          .option("feature", { type: "string", demandOption: true })
          .option("base-branch", { type: "string", default: "main" })
          .option("run-id", { type: "string" })
          .option("runtime", { type: "string" }),
        (argv) => spawnCommand(argv.capability!, argv.name!, {
          task: argv.task!,
          feature: argv.feature!,
          baseBranch: argv.baseBranch!,
          runId: argv.runId,
          runtime: argv.runtime,
        }))

      .command("stop-agent <name>", "Stop an agent",
        (y) => y.positional("name", { type: "string", demandOption: true })
          .option("force", { type: "boolean", default: false }).option("clean", { type: "boolean", default: false }),
        (argv) => stopAgentCommand(argv.name!, { force: argv.force, clean: argv.clean }))

      .command("inspect <name>", "Inspect an agent",
        (y) => y.positional("name", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
        (argv) => inspectCommand(argv.name!, { json: argv.json }))

      .command("nudge <name>", "Send a nudge to an agent",
        (y) => y.positional("name", { type: "string", demandOption: true })
          .option("text", { type: "string", default: "Please check your status and send a heartbeat." }),
        (argv) => nudgeCommand(argv.name!, argv.text!))

      .command("heartbeat <name>", "Record heartbeat",
        (y) => y.positional("name", { type: "string", demandOption: true }),
        (argv) => heartbeatCommand(argv.name!))

      // Mail
      .command("mail", "Inter-agent messaging", (y) => y
        .command("send <to> <subject>", "Send a message",
          (y2) => y2.positional("to", { type: "string", demandOption: true })
            .positional("subject", { type: "string", demandOption: true })
            .option("body", { type: "string", default: "" }).option("type", { type: "string", default: "status" })
            .option("priority", { type: "string", default: "normal" }).option("from", { type: "string" })
            .option("payload", { type: "string" }),
          (argv) => mailSendCommand(argv.to!, argv.subject!, {
            body: argv.body!,
            type: argv.type!,
            priority: argv.priority!,
            from: argv.from,
            payload: argv.payload,
          }))
        .command("check", "Check unread mail",
          (y2) => y2.option("agent", { type: "string", default: "orchestrator" }),
          (argv) => mailCheckCommand(argv.agent!))
        .command("list", "List messages",
          (y2) => y2.option("agent", { type: "string", default: "orchestrator" }).option("limit", { type: "number", default: 20 }),
          (argv) => mailListCommand(argv.agent!, argv.limit))
        .demandCommand(1))

      // Lifecycle
      .command("phase", "Feature lifecycle", (y) => y
        .command("get <feature>", "Get current phase",
          (y2) => y2.positional("feature", { type: "string", demandOption: true }),
          (argv) => phaseGetCommand(argv.feature!))
        .command("advance <feature> <target>", "Advance phase",
          (y2) => y2.positional("feature", { type: "string", demandOption: true })
            .positional("target", { type: "string", demandOption: true }),
          (argv) => phaseAdvanceCommand(argv.feature!, argv.target!))
        .command("list", "List all features", {}, () => phaseListCommand())
        .demandCommand(1))

      // Memory
      .command("memory", "Work tracking (issues)", (y) => y
        .command("create <title>", "Create an issue",
          (y2) => y2.positional("title", { type: "string", demandOption: true })
            .option("type", { type: "string", default: "task" }).option("feature", { type: "string" })
            .option("priority", { type: "number", default: 1 }),
          (argv) => memoryCreateCommand(argv.title!, { type: argv.type!, feature: argv.feature, priority: argv.priority }))
        .command("show <id>", "Show issue",
          (y2) => y2.positional("id", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
          (argv) => memoryShowCommand(argv.id!, { json: argv.json }))
        .command("list", "List issues",
          (y2) => y2.option("feature", { type: "string" }).option("status", { type: "string" }),
          (argv) => memoryListCommand({ feature: argv.feature, status: argv.status }))
        .command("ready", "Ready issues",
          (y2) => y2.option("feature", { type: "string" }),
          (argv) => memoryReadyCommand(argv.feature))
        .command("claim <id> <assignee>", "Claim issue",
          (y2) => y2.positional("id", { type: "string", demandOption: true })
            .positional("assignee", { type: "string", demandOption: true }),
          (argv) => memoryClaimCommand(argv.id!, argv.assignee!))
        .command("close <id>", "Close issue",
          (y2) => y2.positional("id", { type: "string", demandOption: true }),
          (argv) => memoryCloseCommand(argv.id!))
        .command("stats", "Issue stats",
          (y2) => y2.option("feature", { type: "string" }),
          (argv) => memoryStatsCommand(argv.feature))
        .demandCommand(1))

      // Observability
      .command("feed", "Event stream",
        (y) => y.option("agent", { type: "string" }).option("source", { type: "string" }).option("follow", { type: "boolean", default: false }),
        (argv) => feedCommand({ agent: argv.agent, source: argv.source, follow: argv.follow }))

      .command("logs", "Query event log",
        (y) => y.option("agent", { type: "string" }).option("level", { type: "string" }).option("since", { type: "string" })
          .option("limit", { type: "number", default: 50 }).option("json", { type: "boolean", default: false }),
        (argv) => logsCommand({ agent: argv.agent, level: argv.level, since: argv.since, limit: argv.limit, json: argv.json }))

      .command("costs", "Token usage summary",
        (y) => y.option("json", { type: "boolean", default: false }),
        (argv) => costsCommand({ json: argv.json }))

      // Checkpoints
      .command("checkpoint", "Session checkpoints", (y) => y
        .command("save", "Save checkpoint",
          (y2) => y2.option("agent", { type: "string", demandOption: true })
            .option("summary", { type: "string", demandOption: true })
            .option("pending", { type: "string", default: "" }).option("files", { type: "string", default: "" }),
          (argv) => checkpointSaveCommand(argv.agent!, argv.summary!, argv.pending!, argv.files!))
        .command("show <agent>", "Show checkpoint",
          (y2) => y2.positional("agent", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
          (argv) => checkpointShowCommand(argv.agent!, { json: argv.json }))
        .command("progress <agent>", "Show progress artifact",
          (y2) => y2.positional("agent", { type: "string", demandOption: true }),
          (argv) => progressCommand(argv.agent!))
        .command("handoffs <agent>", "Handoff history",
          (y2) => y2.positional("agent", { type: "string", demandOption: true }),
          (argv) => handoffsCommand(argv.agent!))
        .demandCommand(1))

      // Contracts
      .command("contract", "Sprint contracts", (y) => y
        .command("show <contract-id>", "Show contract",
          (y2) => y2.positional("contract-id", { type: "string", demandOption: true })
            .option("feature", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
          (argv) => contractShowCommand(argv.contractId!, argv.feature!, { json: argv.json }))
        .command("accept <contract-id>", "Accept contract",
          (y2) => y2.positional("contract-id", { type: "string", demandOption: true })
            .option("feature", { type: "string", demandOption: true }).option("reviewer", { type: "string", default: "cli" })
            .option("notes", { type: "string" }),
          (argv) => contractAcceptCommand(argv.contractId!, argv.feature!, argv.reviewer!, argv.notes))
        .command("reject <contract-id>", "Reject contract",
          (y2) => y2.positional("contract-id", { type: "string", demandOption: true })
            .option("feature", { type: "string", demandOption: true }).option("reviewer", { type: "string", default: "cli" })
            .option("notes", { type: "string", demandOption: true }),
          (argv) => contractRejectCommand(argv.contractId!, argv.feature!, argv.reviewer!, argv.notes!))
        .demandCommand(1))

      // Grade
      .command("grade", "Show grading rubric",
        (y) => y.option("rubric", { type: "string", default: "default" }),
        (argv) => gradeCommand(argv.rubric!))

      .demandCommand(1, "Run cnog --help for available commands")
      .strict()
      .help()
      .parse();
  } catch (err) {
    if (err instanceof CnogError) {
      console.error(chalk.red(err.message));
      if (err.fix) console.error(chalk.yellow(`  Fix: ${err.fix}`));
    } else if (err instanceof ZodError) {
      const issue = err.issues[0];
      console.error(chalk.red(`Invalid value: ${issue.message}`));
      if (issue.path.length > 0) console.error(chalk.yellow(`  Field: ${issue.path.join(".")}`));
    } else if (err instanceof Error) {
      console.error(chalk.red(err.message));
    }
    process.exitCode = 1;
  }
}
