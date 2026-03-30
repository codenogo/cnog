import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Issue } from "./memory.js";
import type { Plan, PlanTask } from "./planning/plan-factory.js";
import {
  getVerifyCommands,
  requiresPackageChecks,
} from "./planning/profiles.js";

export interface ExecutionSpec {
  planTaskKey: string;
  taskIndex: number;
  task: PlanTask;
  fileScope: string[];
  packageVerifyCommands: string[];
  verifyCommands: string[];
  taskPrompt: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function dedupeCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const command of commands) {
    const normalized = command.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    results.push(normalized);
  }

  return results;
}

function packageCommand(packageDir: string, script: string): string {
  if (script === "test") {
    return packageDir === "."
      ? "npm test"
      : `npm --prefix ${shellQuote(packageDir)} test`;
  }
  if (packageDir === ".") {
    return `npm run ${script}`;
  }
  return `npm --prefix ${shellQuote(packageDir)} run ${script}`;
}

function findNearestPackageDir(projectRoot: string, filePath: string): string | null {
  let current = dirname(resolve(projectRoot, filePath));
  const root = resolve(projectRoot);

  while (current.startsWith(root)) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    if (current === root) {
      break;
    }
    current = dirname(current);
  }

  return existsSync(join(root, "package.json")) ? root : null;
}

export function planTaskKeyFor(plan: Pick<Plan, "feature" | "planNumber">, taskIndex: number): string {
  return `${plan.feature}:${plan.planNumber}:${String(taskIndex).padStart(2, "0")}`;
}

export function planTaskKeyFromIssue(issue: Pick<Issue, "metadata">): string | null {
  const candidate = issue.metadata?.planTaskKey;
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

export function findPlanTaskForIssue(
  issue: Pick<Issue, "title" | "metadata">,
  plan: Plan,
): { task: PlanTask; taskIndex: number; planTaskKey: string } | null {
  const issueTaskKey = planTaskKeyFromIssue(issue);
  if (issueTaskKey) {
    for (let index = 0; index < plan.tasks.length; index += 1) {
      if (planTaskKeyFor(plan, index) === issueTaskKey) {
        return {
          task: plan.tasks[index],
          taskIndex: index,
          planTaskKey: issueTaskKey,
        };
      }
    }
  }

  const metadataIndex = issue.metadata?.planTaskIndex;
  if (typeof metadataIndex === "number") {
    const task = plan.tasks[metadataIndex];
    if (task) {
      return {
        task,
        taskIndex: metadataIndex,
        planTaskKey: planTaskKeyFor(plan, metadataIndex),
      };
    }
  }

  const fallbackIndex = plan.tasks.findIndex((task) => task.name === issue.title);
  if (fallbackIndex >= 0) {
    return {
      task: plan.tasks[fallbackIndex],
      taskIndex: fallbackIndex,
      planTaskKey: planTaskKeyFor(plan, fallbackIndex),
    };
  }

  return null;
}

export function derivePackageVerifyCommands(
  fileScope: string[],
  projectRoot: string,
): string[] {
  if (fileScope.length === 0) return [];

  const packageRoots = new Set<string>();
  for (const filePath of fileScope) {
    const packageRoot = findNearestPackageDir(projectRoot, filePath);
    if (packageRoot) {
      packageRoots.add(packageRoot);
    }
  }

  if (packageRoots.size !== 1) {
    return [];
  }

  const packageRoot = [...packageRoots][0];
  try {
    const raw = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = raw.scripts ?? {};
    const relativePackageDir = relative(projectRoot, packageRoot) || ".";

    return ["lint", "typecheck", "test"]
      .filter((script) => typeof scripts[script] === "string" && scripts[script].trim().length > 0)
      .map((script) => packageCommand(relativePackageDir, script));
  } catch {
    return [];
  }
}

function buildTaskPrompt(
  task: PlanTask,
  plan: Plan,
  verifyCommands: string[],
): string {
  const lines: string[] = [];

  lines.push(`Implement: ${task.name}`);
  lines.push("");
  lines.push(task.action);

  if (task.microSteps && task.microSteps.length > 0) {
    lines.push("");
    lines.push("## Steps");
    task.microSteps.forEach((step, i) => {
      lines.push(`${i + 1}. ${step}`);
    });
  }

  if (task.contextLinks && task.contextLinks.length > 0) {
    lines.push("");
    lines.push("## Context");
    task.contextLinks.forEach((link) => {
      lines.push(`- ${link}`);
    });
  }

  if (task.tdd?.required) {
    lines.push("");
    lines.push("## TDD");
    if (task.tdd.failingVerify) {
      lines.push(`- Failing test first: \`${task.tdd.failingVerify}\``);
    }
    if (task.tdd.passingVerify) {
      lines.push(`- Then make it pass: \`${task.tdd.passingVerify}\``);
    }
  }

  lines.push("");
  lines.push("## Verify Commands");
  verifyCommands.forEach((command) => {
    lines.push(`- \`${command}\``);
  });

  if (plan.planVerify.length > 0) {
    lines.push("");
    lines.push("## Plan Verify");
    plan.planVerify.forEach((command) => {
      lines.push(`- \`${command}\``);
    });
  }

  return lines.join("\n");
}

export function buildExecutionSpec(opts: {
  plan: Plan;
  task: PlanTask;
  taskIndex: number;
  profileName?: string;
  projectRoot?: string;
}): ExecutionSpec {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const packageVerifyCommands = opts.profileName && requiresPackageChecks(opts.profileName)
    ? derivePackageVerifyCommands(opts.task.files, projectRoot)
    : [];
  const profileVerifyCommands = opts.profileName
    ? getVerifyCommands(opts.profileName)
    : opts.plan.planVerify;
  const verifyCommands = dedupeCommands([
    ...opts.task.verify,
    ...packageVerifyCommands,
    ...profileVerifyCommands,
  ]);

  return {
    planTaskKey: planTaskKeyFor(opts.plan, opts.taskIndex),
    taskIndex: opts.taskIndex,
    task: opts.task,
    fileScope: [...opts.task.files],
    packageVerifyCommands,
    verifyCommands,
    taskPrompt: buildTaskPrompt(opts.task, opts.plan, verifyCommands),
  };
}
