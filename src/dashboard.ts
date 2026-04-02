/**
 * Terminal dashboard — live TUI for monitoring the orchestrator.
 *
 * Displays agents table, merge queue, recent events, and summary.
 * Refreshes every 2 seconds using ANSI escape codes (no external TUI lib).
 */

import chalk from "chalk";

import type { CnogDB } from "./db.js";
import type { RunRow } from "./types.js";
import { buildExecutionTaskStatuses } from "./status.js";

const REFRESH_INTERVAL_MS = 2000;

function stateColor(state: string): string {
  switch (state) {
    case "booting":
      return chalk.cyan(state);
    case "working":
      return chalk.green(state);
    case "completed":
      return chalk.gray(state);
    case "stalled":
      return chalk.yellow(state);
    case "failed":
      return chalk.red(state);
    default:
      return state;
  }
}

function mergeStatusColor(status: string): string {
  switch (status) {
    case "pending":
      return chalk.yellow(status);
    case "merging":
      return chalk.cyan(status);
    case "merged":
      return chalk.green(status);
    case "conflict":
      return chalk.red(status);
    case "failed":
      return chalk.red(status);
    default:
      return status;
  }
}

function taskStatusColor(status: string): string {
  switch (status) {
    case "pending":
      return chalk.yellow(status);
    case "running":
      return chalk.green(status);
    case "blocked":
      return chalk.yellowBright(status);
    case "completed":
      return chalk.gray(status);
    case "failed":
      return chalk.red(status);
    case "superseded":
      return chalk.magenta(status);
    default:
      return status;
  }
}

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function formatDuration(startedAt: string, completedAt?: string | null): string {
  const start = Date.parse(startedAt.replace(" ", "T"));
  if (Number.isNaN(start)) return "-";
  const end = completedAt ? Date.parse(completedAt.replace(" ", "T")) : Date.now();
  if (Number.isNaN(end)) return "-";
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function buildAgentsTable(db: CnogDB): string {
  const sessions = db.sessions.active();
  const lines: string[] = [];

  lines.push(chalk.bold("AGENTS"));
  lines.push(
    `${pad("Name", 26)} ${pad("Capability", 12)} ${pad("Feature", 18)} ${pad("State", 12)} ${pad("Tools", 7)} ${pad("Tokens", 12)} ${pad("Duration", 10)} ${pad("Heartbeat", 12)} ${pad("Last Activity", 34)}`,
  );
  lines.push("-".repeat(156));

  if (sessions.length === 0) {
    lines.push(chalk.gray("  No active agents"));
  }

  for (const s of sessions) {
    const progress = db.sessionProgress.get(s.id);
    const hb = s.last_heartbeat
      ? new Date(s.last_heartbeat).toLocaleTimeString()
      : "-";
    const activity = progress?.last_activity_summary ?? "-";
    const totalTokens = (progress?.input_tokens ?? 0) + (progress?.output_tokens ?? 0);
    lines.push(
      `${pad(s.name, 26)} ${pad(s.capability, 12)} ${pad(s.feature ?? "-", 18)} ${pad(stateColor(s.state), 22)} ${pad(String(progress?.tool_use_count ?? 0), 7)} ${pad(String(totalTokens), 12)} ${pad(formatDuration(s.started_at, s.completed_at), 10)} ${pad(hb, 12)} ${pad(activity, 34)}`,
    );
    if (progress?.transcript_path) {
      lines.push(chalk.gray(`  transcript: ${progress.transcript_path}`));
    }
    if (s.execution_task_id) {
      const task = db.executionTasks.get(s.execution_task_id);
      if (task?.output_path) {
        lines.push(chalk.gray(`  log: ${task.output_path}`));
      }
    }
    if ((progress?.cost_usd ?? 0) > 0) {
      lines.push(chalk.gray(`  usage: in=${progress?.input_tokens ?? 0} out=${progress?.output_tokens ?? 0} cost=$${(progress?.cost_usd ?? 0).toFixed(4)}`));
    }
  }

  return lines.join("\n");
}

function buildTasksTable(db: CnogDB): string {
  const runs = db.db.prepare(
    "SELECT * FROM runs WHERE status NOT IN ('done','failed') ORDER BY created_at DESC",
  ).all() as RunRow[];
  const tasks = buildExecutionTaskStatuses(db, runs);
  const lines: string[] = [];

  lines.push(chalk.bold("TASKS"));
  lines.push(
    `${pad("Logical Name", 34)} ${pad("Kind", 22)} ${pad("Feature", 18)} ${pad("Status", 12)} ${pad("Attempt", 40)}`,
  );
  lines.push("-".repeat(132));

  if (tasks.length === 0) {
    lines.push(chalk.gray("  No active execution tasks"));
  }

  for (const task of tasks) {
    const attemptLabel = task.selectedSession
      ? `${task.selectedSession}${task.selectedAttempt ? `#${task.selectedAttempt}` : ""} (${task.selectedReason})`
      : "-";
    lines.push(
      `${pad(task.logicalName, 34)} ${pad(`${task.executor}/${task.kind}`, 22)} ${pad(task.feature, 18)} ${pad(taskStatusColor(task.status), 22)} ${pad(attemptLabel, 40)}`,
    );
    if (task.summary) {
      lines.push(chalk.gray(`  ${task.summary}`));
    } else if (task.issueTitle) {
      lines.push(chalk.gray(`  ${task.issueTitle}`));
    }
    if (task.lastError) {
      lines.push(chalk.red(`  error: ${task.lastError}`));
    }
    if (task.outputPath) {
      lines.push(chalk.gray(`  log: ${task.outputPath}`));
    }
    if (task.resultPath) {
      lines.push(chalk.gray(`  result: ${task.resultPath}`));
    }
    if (task.transcriptPath) {
      lines.push(chalk.gray(`  transcript: ${task.transcriptPath}`));
    }
    if (task.parentTaskId) {
      lines.push(chalk.gray(`  parent: ${task.parentTaskId}`));
    }
  }

  return lines.join("\n");
}

function buildMergeTable(db: CnogDB): string {
  const entries = db.merges.pending();
  const lines: string[] = [];

  lines.push(chalk.bold("MERGE QUEUE"));
  lines.push(
    `${pad("Branch", 40)} ${pad("Feature", 20)} ${pad("Status", 12)} ${pad("Tier", 10)}`,
  );
  lines.push("-".repeat(84));

  if (entries.length === 0) {
    lines.push(chalk.gray("  No pending merges"));
  }

  for (const e of entries) {
    lines.push(
      `${pad(e.branch, 40)} ${pad(e.feature, 20)} ${pad(mergeStatusColor(e.status), 22)} ${pad(e.resolved_tier ?? "-", 10)}`,
    );
  }

  return lines.join("\n");
}

function buildEventsPanel(db: CnogDB): string {
  const events = db.events.query({ limit: 8 });
  const lines: string[] = [];

  lines.push(chalk.bold("RECENT EVENTS"));
  lines.push("-".repeat(80));

  if (events.length === 0) {
    lines.push(chalk.gray("  No events"));
  }

  for (const e of events) {
    const levelTag =
      e.level === "error"
        ? chalk.red(`[${e.level}]`)
        : e.level === "warn"
          ? chalk.yellow(`[${e.level}]`)
          : chalk.gray(`[${e.level}]`);

    const time = e.timestamp.slice(11, 19);
    lines.push(`  ${chalk.gray(time)} ${levelTag} ${e.message}`);
  }

  return lines.join("\n");
}

function buildSummary(db: CnogDB): string {
  const active = db.sessions.active();
  const runs = db.db.prepare(
    "SELECT * FROM runs WHERE status NOT IN ('done','failed') ORDER BY created_at DESC",
  ).all() as RunRow[];
  const tasks = buildExecutionTaskStatuses(db, runs);
  const pending = db.merges.pending();
  const unread = db.messages.checkMail("orchestrator");
  const costs = db.metrics.summary();

  const lines: string[] = [];
  lines.push(chalk.bold("SUMMARY"));
  lines.push("-".repeat(30));
  lines.push(`  Active agents: ${active.length}`);
  lines.push(`  Active tasks: ${tasks.filter((task) => task.status === "pending" || task.status === "running").length}`);
  lines.push(`  Blocked tasks: ${tasks.filter((task) => task.status === "blocked").length}`);
  lines.push(`  Failed tasks: ${tasks.filter((task) => task.status === "failed").length}`);
  lines.push(`  Superseded tasks: ${tasks.filter((task) => task.status === "superseded").length}`);
  lines.push(`  Pending merges: ${pending.length}`);
  lines.push(`  Unread mail: ${unread.length}`);
  lines.push(`  Total cost: $${costs.total_cost.toFixed(4)}`);

  return lines.join("\n");
}

/**
 * Build the full dashboard display string.
 */
export function buildDisplay(db: CnogDB): string {
  const sections = [
    buildAgentsTable(db),
    "",
    buildTasksTable(db),
    "",
    buildMergeTable(db),
    "",
    buildEventsPanel(db),
    "",
    buildSummary(db),
  ];

  return sections.join("\n");
}

/**
 * Run the live dashboard with periodic refresh.
 */
export function runDashboard(
  db: CnogDB,
  refreshInterval: number = REFRESH_INTERVAL_MS,
): void {
  const render = () => {
    // Clear screen
    process.stdout.write("\x1B[2J\x1B[0f");
    process.stdout.write(
      chalk.bold.blue("cnog dashboard") +
        chalk.gray(` — ${new Date().toLocaleTimeString()}`) +
        "\n\n",
    );
    process.stdout.write(buildDisplay(db) + "\n");
  };

  render();
  const timer = setInterval(render, refreshInterval);

  // Clean exit
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.stdout.write("\x1B[2J\x1B[0f");
    process.exit(0);
  });
}
