/**
 * Terminal dashboard — live TUI for monitoring the orchestrator.
 *
 * Displays agents table, merge queue, recent events, and summary.
 * Refreshes every 2 seconds using ANSI escape codes (no external TUI lib).
 */

import chalk from "chalk";

import type { CnogDB } from "./db.js";

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

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function buildAgentsTable(db: CnogDB): string {
  const sessions = db.sessions.active();
  const lines: string[] = [];

  lines.push(chalk.bold("AGENTS"));
  lines.push(
    `${pad("Name", 30)} ${pad("Capability", 12)} ${pad("Feature", 20)} ${pad("State", 12)} ${pad("Heartbeat", 20)}`,
  );
  lines.push("-".repeat(96));

  if (sessions.length === 0) {
    lines.push(chalk.gray("  No active agents"));
  }

  for (const s of sessions) {
    const hb = s.last_heartbeat
      ? new Date(s.last_heartbeat).toLocaleTimeString()
      : "-";
    lines.push(
      `${pad(s.name, 30)} ${pad(s.capability, 12)} ${pad(s.feature ?? "-", 20)} ${pad(stateColor(s.state), 22)} ${pad(hb, 20)}`,
    );
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
  const pending = db.merges.pending();
  const unread = db.messages.checkMail("orchestrator");
  const costs = db.metrics.summary();

  const lines: string[] = [];
  lines.push(chalk.bold("SUMMARY"));
  lines.push("-".repeat(30));
  lines.push(`  Active agents: ${active.length}`);
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
