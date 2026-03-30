/**
 * Plan generation, validation, and I/O.
 *
 * A Plan is a structured task decomposition for a feature.
 * Schema version 3 supports TDD config, micro-steps, and dependencies.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { featureDir as getFeatureDir, PLAN_SCHEMA_VERSION } from "../paths.js";

export interface TddConfig {
  required: boolean;
  reason?: string;
  failingVerify?: string;
  passingVerify?: string;
}

export interface PlanTask {
  name: string;
  files: string[];
  action: string;
  verify: string[];
  microSteps?: string[];
  tdd?: TddConfig;
  blockedBy?: string[];
  contextLinks?: string[];
}

export interface Plan {
  schemaVersion: number;
  feature: string;
  planNumber: string;
  goal: string;
  tasks: PlanTask[];
  planVerify: string[];
  commitMessage: string;
  profile?: string;
  timestamp?: string;
}

// Schema version imported from paths.ts

/**
 * Get the next plan number for a feature (e.g., "01", "02").
 */
export function nextPlanNumber(feature: string, projectRoot: string): string {
  const featureDir = getFeatureDir(feature, projectRoot);

  if (!existsSync(featureDir)) return "01";

  const files = readdirSync(featureDir).filter((f) =>
    f.endsWith("-PLAN.json"),
  );
  const numbers = files.map((f) => parseInt(f.split("-")[0], 10)).filter(Boolean);
  const max = numbers.length > 0 ? Math.max(...numbers) : 0;
  return String(max + 1).padStart(2, "0");
}

/**
 * Load a plan from disk.
 */
export function loadPlan(
  feature: string,
  planNumber: string,
  projectRoot: string,
): Plan | null {
  const filePath = join(getFeatureDir(feature, projectRoot), `${planNumber}-PLAN.json`);

  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Plan;
  } catch {
    return null;
  }
}

/**
 * Load the latest numbered plan for a feature.
 */
export function loadLatestPlan(
  feature: string,
  projectRoot: string,
): Plan | null {
  const featurePath = getFeatureDir(feature, projectRoot);

  if (!existsSync(featurePath)) return null;

  const files = readdirSync(featurePath)
    .filter((f) => f.endsWith("-PLAN.json"))
    .sort((a, b) => {
      const numA = parseInt(a.split("-")[0], 10) || 0;
      const numB = parseInt(b.split("-")[0], 10) || 0;
      return numA - numB;
    });

  const latest = files[files.length - 1];
  if (!latest) return null;

  try {
    return JSON.parse(
      readFileSync(join(featurePath, latest), "utf-8"),
    ) as Plan;
  } catch {
    return null;
  }
}

/**
 * Write a plan to disk.
 */
export function writePlan(plan: Plan, projectRoot: string): string {
  const dir = getFeatureDir(plan.feature, projectRoot);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `${plan.planNumber}-PLAN.json`);
  writeFileSync(filePath, JSON.stringify(plan, null, 2), "utf-8");
  return filePath;
}

/**
 * Render a plan as markdown for human review.
 */
export function renderPlanMd(plan: Plan): string {
  const lines: string[] = [];

  lines.push(`# Plan: ${plan.feature} (${plan.planNumber})`);
  lines.push("");
  lines.push(`**Goal:** ${plan.goal}`);
  lines.push(`**Profile:** ${plan.profile ?? "default"}`);
  lines.push(`**Schema:** v${plan.schemaVersion}`);
  lines.push("");

  lines.push("## Tasks");
  lines.push("");

  for (const task of plan.tasks) {
    lines.push(`### ${task.name}`);
    lines.push("");
    lines.push(task.action);
    lines.push("");

    lines.push("**Files:**");
    task.files.forEach((f) => lines.push(`- \`${f}\``));
    lines.push("");

    lines.push("**Verify:**");
    task.verify.forEach((v) => lines.push(`- \`${v}\``));

    if (task.microSteps && task.microSteps.length > 0) {
      lines.push("");
      lines.push("**Steps:**");
      task.microSteps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }

    if (task.blockedBy && task.blockedBy.length > 0) {
      lines.push("");
      lines.push(`**Blocked by:** ${task.blockedBy.join(", ")}`);
    }

    if (task.tdd?.required) {
      lines.push("");
      lines.push("**TDD:** Required");
    }

    lines.push("");
  }

  lines.push("## Plan Verify");
  plan.planVerify.forEach((v) => lines.push(`- \`${v}\``));
  lines.push("");
  lines.push(`**Commit:** ${plan.commitMessage}`);

  return lines.join("\n");
}

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a plan against schema v3 requirements.
 */
export function validatePlan(plan: Plan): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!plan.schemaVersion) {
    errors.push({ field: "schemaVersion", message: "Missing schemaVersion" });
  }

  if (!plan.feature) {
    errors.push({ field: "feature", message: "Missing feature name" });
  }

  if (!plan.planNumber) {
    errors.push({ field: "planNumber", message: "Missing planNumber" });
  }

  if (!plan.goal) {
    errors.push({ field: "goal", message: "Missing goal" });
  }

  if (!plan.tasks || plan.tasks.length === 0) {
    errors.push({ field: "tasks", message: "Plan must have at least one task" });
  }

  if (!plan.planVerify || plan.planVerify.length === 0) {
    errors.push({
      field: "planVerify",
      message: "Plan must have at least one verify command",
    });
  }

  if (!plan.commitMessage) {
    errors.push({ field: "commitMessage", message: "Missing commitMessage" });
  }

  // Validate each task
  if (plan.tasks) {
    const taskNames = new Set<string>();

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      const prefix = `tasks[${i}]`;

      if (!task.name) {
        errors.push({ field: `${prefix}.name`, message: "Missing task name" });
      } else if (taskNames.has(task.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate task name: ${task.name}`,
        });
      } else {
        taskNames.add(task.name);
      }

      if (!task.files || task.files.length === 0) {
        errors.push({
          field: `${prefix}.files`,
          message: "Task must list files",
        });
      }

      if (!task.verify || task.verify.length === 0) {
        errors.push({
          field: `${prefix}.verify`,
          message: "Task must have verify commands",
        });
      }

      // Check blockedBy references
      if (task.blockedBy) {
        for (const dep of task.blockedBy) {
          if (!taskNames.has(dep) && !plan.tasks.some((t) => t.name === dep)) {
            errors.push({
              field: `${prefix}.blockedBy`,
              message: `Unknown dependency: ${dep}`,
            });
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Create a blank plan template.
 */
export function createBlankPlan(
  feature: string,
  projectRoot: string,
): Plan {
  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    feature,
    planNumber: nextPlanNumber(feature, projectRoot),
    goal: "",
    tasks: [],
    planVerify: [],
    commitMessage: `feat(${feature}): `,
    timestamp: new Date().toISOString(),
  };
}
