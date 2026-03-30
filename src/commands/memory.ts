import chalk from "chalk";

import { IssueTypeSchema } from "../types.js";
import { MemoryEngine } from "../memory.js";
import { withDb } from "./context.js";

export function memoryCreateCommand(title: string, opts: { type: string; feature?: string; priority: number }): void {
  const issueType = IssueTypeSchema.parse(opts.type);
  withDb((db) => {
    const memory = new MemoryEngine(db);
    const issue = memory.create({ title, issueType, feature: opts.feature, priority: opts.priority });
    console.log(chalk.green(`Created ${issue.id}: ${issue.title}`));
  });
}

export function memoryShowCommand(id: string, opts: { json: boolean }): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    const issue = memory.get(id);
    if (!issue) { console.log(chalk.red("Issue not found.")); return; }
    if (opts.json) { console.log(JSON.stringify(issue, null, 2)); return; }
    console.log(chalk.bold(issue.title));
    console.log(`  ID: ${issue.id}`);
    console.log(`  Type: ${issue.issueType}`);
    console.log(`  Status: ${issue.status}`);
    console.log(`  Priority: ${issue.priority}`);
    console.log(`  Assignee: ${issue.assignee ?? "-"}`);
    console.log(`  Feature: ${issue.feature ?? "-"}`);
    if (issue.deps.length > 0) console.log(`  Deps: ${issue.deps.join(", ")}`);
  });
}

export function memoryListCommand(opts: { feature?: string; status?: string }): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    const issues = memory.list(opts);
    if (issues.length === 0) { console.log(chalk.gray("No issues found.")); return; }
    for (const i of issues) console.log(`  [${i.status}] ${i.id}: ${i.title} (${i.feature ?? "-"})`);
  });
}

export function memoryReadyCommand(feature?: string): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    const ready = memory.ready(feature);
    if (ready.length === 0) { console.log(chalk.gray("No ready issues.")); return; }
    for (const i of ready) console.log(`  ${i.id}: ${i.title}`);
  });
}

export function memoryClaimCommand(id: string, assignee: string): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    memory.claim(id, assignee);
    console.log(chalk.green(`Claimed ${id} for ${assignee}`));
  });
}

export function memoryCloseCommand(id: string): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    memory.close(id);
    console.log(chalk.green(`Closed ${id}`));
  });
}

export function memoryStatsCommand(feature?: string): void {
  withDb((db) => {
    const memory = new MemoryEngine(db);
    const stats = memory.stats(feature);
    for (const [status, count] of Object.entries(stats)) console.log(`  ${status}: ${count}`);
  });
}
