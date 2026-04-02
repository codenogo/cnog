/**
 * CLI entry point — thin yargs router.
 *
 * Each command delegates to a handler in src/commands/.
 * This file only defines the argument schema and routes to handlers.
 */

import yargs from "yargs";
import chalk from "chalk";
import { ZodError } from "zod";

import { CnogError } from "./errors.js";

function lazyCommand(loader: () => Promise<Record<string, unknown>>, key: string) {
  return async (...args: unknown[]): Promise<void> => {
    const mod = await loader();
    const handler = mod[key];
    if (typeof handler !== "function") {
      throw new Error(`Command export ${key} was not found.`);
    }
    await (handler as (...innerArgs: unknown[]) => unknown)(...args);
  };
}

const initCommand = lazyCommand(() => import("./commands/init.js"), "initCommand");
const doctorCommand = lazyCommand(() => import("./commands/doctor.js"), "doctorCommand");
const statusCommand = lazyCommand(() => import("./commands/status.js"), "statusCommand");
const startCommand = lazyCommand(() => import("./commands/orchestrator.js"), "startCommand");
const stopCommand = lazyCommand(() => import("./commands/orchestrator.js"), "stopCommand");
const orchLogsCommand = lazyCommand(() => import("./commands/orchestrator.js"), "logsCommand");
const slingCommand = lazyCommand(() => import("./commands/agents.js"), "slingCommand");
const agentsListCommand = lazyCommand(() => import("./commands/agents.js"), "agentsListCommand");
const spawnCommand = lazyCommand(() => import("./commands/agents.js"), "spawnCommand");
const stopAgentCommand = lazyCommand(() => import("./commands/agents.js"), "stopAgentCommand");
const inspectCommand = lazyCommand(() => import("./commands/agents.js"), "inspectCommand");
const nudgeCommand = lazyCommand(() => import("./commands/agents.js"), "nudgeCommand");
const heartbeatCommand = lazyCommand(() => import("./commands/agents.js"), "heartbeatCommand");
const evaluateCommand = lazyCommand(() => import("./commands/agents.js"), "evaluateCommand");
const mailSendCommand = lazyCommand(() => import("./commands/mail.js"), "mailSendCommand");
const mailCheckCommand = lazyCommand(() => import("./commands/mail.js"), "mailCheckCommand");
const mailListCommand = lazyCommand(() => import("./commands/mail.js"), "mailListCommand");
const reportBlockedCommand = lazyCommand(() => import("./commands/mail.js"), "reportBlockedCommand");
const reportBuilderCompleteCommand = lazyCommand(() => import("./commands/mail.js"), "reportBuilderCompleteCommand");
const reportContractReviewCommand = lazyCommand(() => import("./commands/mail.js"), "reportContractReviewCommand");
const reportGenericCompleteCommand = lazyCommand(() => import("./commands/mail.js"), "reportGenericCompleteCommand");
const reportImplementationReviewCommand = lazyCommand(() => import("./commands/mail.js"), "reportImplementationReviewCommand");
const reportPlannerCompleteCommand = lazyCommand(() => import("./commands/mail.js"), "reportPlannerCompleteCommand");
const phaseGetCommand = lazyCommand(() => import("./commands/lifecycle.js"), "phaseGetCommand");
const phaseAdvanceCommand = lazyCommand(() => import("./commands/lifecycle.js"), "phaseAdvanceCommand");
const phaseListCommand = lazyCommand(() => import("./commands/lifecycle.js"), "phaseListCommand");
const shipCommand = lazyCommand(() => import("./commands/lifecycle.js"), "shipCommand");
const runResetCommand = lazyCommand(() => import("./commands/lifecycle.js"), "runResetCommand");
const runListCommand = lazyCommand(() => import("./commands/lifecycle.js"), "runListCommand");
const runShowCommand = lazyCommand(() => import("./commands/lifecycle.js"), "runShowCommand");
const memoryCreateCommand = lazyCommand(() => import("./commands/memory.js"), "memoryCreateCommand");
const memoryShowCommand = lazyCommand(() => import("./commands/memory.js"), "memoryShowCommand");
const memoryListCommand = lazyCommand(() => import("./commands/memory.js"), "memoryListCommand");
const memoryReadyCommand = lazyCommand(() => import("./commands/memory.js"), "memoryReadyCommand");
const memoryClaimCommand = lazyCommand(() => import("./commands/memory.js"), "memoryClaimCommand");
const memoryCloseCommand = lazyCommand(() => import("./commands/memory.js"), "memoryCloseCommand");
const memoryStatsCommand = lazyCommand(() => import("./commands/memory.js"), "memoryStatsCommand");
const planCommand = lazyCommand(() => import("./commands/planning.js"), "planCommand");
const shapeCommand = lazyCommand(() => import("./commands/planning.js"), "shapeCommand");
const mergeCommand = lazyCommand(() => import("./commands/planning.js"), "mergeCommand");
const dashboardCommand = lazyCommand(() => import("./commands/observability.js"), "dashboardCommand");
const feedCommand = lazyCommand(() => import("./commands/observability.js"), "feedCommand");
const logsCommand = lazyCommand(() => import("./commands/observability.js"), "logsCommand");
const costsCommand = lazyCommand(() => import("./commands/observability.js"), "costsCommand");
const checkpointSaveCommand = lazyCommand(() => import("./commands/observability.js"), "checkpointSaveCommand");
const checkpointShowCommand = lazyCommand(() => import("./commands/observability.js"), "checkpointShowCommand");
const progressCommand = lazyCommand(() => import("./commands/observability.js"), "progressCommand");
const handoffsCommand = lazyCommand(() => import("./commands/observability.js"), "handoffsCommand");
const runtimeProgressShowCommand = lazyCommand(() => import("./commands/observability.js"), "runtimeProgressShowCommand");
const runtimeProgressUpdateCommand = lazyCommand(() => import("./commands/observability.js"), "runtimeProgressUpdateCommand");
const contractShowCommand = lazyCommand(() => import("./commands/observability.js"), "contractShowCommand");
const contractAcceptCommand = lazyCommand(() => import("./commands/observability.js"), "contractAcceptCommand");
const contractRejectCommand = lazyCommand(() => import("./commands/observability.js"), "contractRejectCommand");
const gradeCommand = lazyCommand(() => import("./commands/observability.js"), "gradeCommand");

export async function main(args: string[]): Promise<void> {
  try {
    await yargs(args)
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
      .command({
        command: "start",
        describe: "Start orchestrator",
        builder: (y) => y.option("foreground", { type: "boolean", default: false }),
        handler: (argv) => {
          startCommand({ foreground: Boolean(argv.foreground) });
        },
      })
      .command("stop", "Stop orchestrator", {}, () => stopCommand())
      .command("orchestrator-logs", "Show orchestrator daemon log", {}, () => orchLogsCommand())

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

      .command("progress", "Runtime progress tracking", (y) => y
        .command("update <agent>", "Record runtime progress",
          (y2) => y2.positional("agent", { type: "string", demandOption: true })
            .option("tool", { type: "string" })
            .option("target", { type: "string" })
            .option("input-tokens", { type: "number" })
            .option("output-tokens", { type: "number" })
            .option("cost-usd", { type: "number" })
            .option("quiet", { type: "boolean", default: false }),
          (argv) => runtimeProgressUpdateCommand({
            agent: argv.agent!,
            tool: argv.tool,
            target: argv.target,
            inputTokens: argv.inputTokens,
            outputTokens: argv.outputTokens,
            costUsd: argv.costUsd,
            quiet: argv.quiet,
          }))
        .command("show <agent>", "Show runtime progress",
          (y2) => y2.positional("agent", { type: "string", demandOption: true })
            .option("json", { type: "boolean", default: false }),
          (argv) => runtimeProgressShowCommand(argv.agent!, { json: argv.json }))
        .demandCommand(1))

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

      .command("report", "Structured worker reporting", (y) => y
        .command("builder-complete", "Report builder completion",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("agent", { type: "string" })
            .option("head-sha", { type: "string" })
            .option("files", { type: "string" }),
          (argv) => reportBuilderCompleteCommand({
            summary: argv.summary!,
            agent: argv.agent,
            headSha: argv.headSha,
            files: argv.files,
          }))
        .command("planner-complete", "Report planner completion",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("plan-path", { type: "string", demandOption: true })
            .option("task-count", { type: "number", demandOption: true })
            .option("plan-hash", { type: "string" })
            .option("agent", { type: "string" }),
          (argv) => reportPlannerCompleteCommand({
            summary: argv.summary!,
            planPath: argv.planPath!,
            taskCount: argv.taskCount!,
            planHash: argv.planHash,
            agent: argv.agent,
          }))
        .command("generic-complete", "Report generic completion",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("role", { type: "string", demandOption: true })
            .option("agent", { type: "string" }),
          (argv) => reportGenericCompleteCommand({
            summary: argv.summary!,
            role: argv.role!,
            agent: argv.agent,
          }))
        .command("contract-review", "Report contract review decisions",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("decisions", { type: "string", demandOption: true })
            .option("agent", { type: "string" }),
          (argv) => reportContractReviewCommand({
            summary: argv.summary!,
            decisions: argv.decisions!,
            agent: argv.agent,
          }))
        .command("implementation-review", "Report implementation review verdict",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("verdict", { type: "string", demandOption: true })
            .option("scores", { type: "string", demandOption: true })
            .option("rework-phase", { type: "string" })
            .option("scope-id", { type: "string" })
            .option("scope-hash", { type: "string" })
            .option("agent", { type: "string" }),
          (argv) => reportImplementationReviewCommand({
            summary: argv.summary!,
            verdict: argv.verdict!,
            scores: argv.scores!,
            reworkPhase: argv.reworkPhase,
            scopeId: argv.scopeId,
            scopeHash: argv.scopeHash,
            agent: argv.agent,
          }))
        .command("blocked", "Report blocked worker state",
          (y2) => y2.option("summary", { type: "string", demandOption: true })
            .option("code", { type: "string", demandOption: true })
            .option("role", { type: "string", demandOption: true })
            .option("evidence", { type: "string" })
            .option("requested-action", { type: "string" })
            .option("agent", { type: "string" }),
          (argv) => reportBlockedCommand({
            summary: argv.summary!,
            code: argv.code!,
            role: argv.role!,
            evidence: argv.evidence,
            requestedAction: argv.requestedAction,
            agent: argv.agent,
          }))
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
      .parseAsync();
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
