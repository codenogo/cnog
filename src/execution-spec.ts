import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type { Issue } from "./memory.js";
import type { Plan, PlanTask } from "./planning/plan-factory.js";
import type { BuilderAssignmentSpec } from "./prompt-contract.js";
import { buildLaunchPrompt, createBuilderAssignmentSpec } from "./prompt-contract.js";
import {
  getVerifyCommands,
  requiresPackageChecks,
} from "./planning/profiles.js";

export interface ExecutionSpec {
  planTaskKey: string;
  taskIndex: number;
  task: PlanTask;
  assignment: BuilderAssignmentSpec;
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
  const assignment: BuilderAssignmentSpec = createBuilderAssignmentSpec({
    objective: `Implement ${opts.task.name} for feature ${opts.plan.feature}`,
    planTaskKey: planTaskKeyFor(opts.plan, opts.taskIndex),
    taskIndex: opts.taskIndex,
    taskName: opts.task.name,
    action: opts.task.action,
    planGoal: opts.plan.goal,
    fileScope: opts.task.files,
    microSteps: opts.task.microSteps,
    contextLinks: opts.task.contextLinks,
    canonicalVerifyCommands: verifyCommands,
    packageVerifyCommands,
  });

  return {
    planTaskKey: assignment.planTaskKey,
    taskIndex: opts.taskIndex,
    task: opts.task,
    assignment,
    fileScope: [...opts.task.files],
    packageVerifyCommands,
    verifyCommands,
    taskPrompt: buildLaunchPrompt(assignment),
  };
}
