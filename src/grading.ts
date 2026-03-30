/**
 * Structured grading system for evaluation.
 *
 * Inspired by Anthropic's GAN-inspired evaluator pattern:
 * - Weighted criteria with hard thresholds
 * - If any criterion falls below its threshold, the sprint fails
 * - Scores are 0.0-1.0 per criterion
 * - Weighted average determines overall pass/fail
 *
 * The evaluator is separated from the generator to avoid self-praise bias.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { REVIEWS_DIR } from "./paths.js";

import type {
  GradingCriterion,
  GradingRubric,
  GradeResult,
  GradingReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Default rubrics by capability
// ---------------------------------------------------------------------------

export const DEFAULT_REVIEW_RUBRIC: GradingRubric = {
  criteria: [
    {
      name: "functionality",
      description:
        "Does the implementation correctly satisfy the task requirements? " +
        "Are all acceptance criteria met? Do verify commands pass?",
      weight: 0.35,
      threshold: 0.7,
    },
    {
      name: "completeness",
      description:
        "Is the implementation complete? Are there stubs, TODOs, or missing " +
        "pieces? Does it handle edge cases appropriately?",
      weight: 0.25,
      threshold: 0.6,
    },
    {
      name: "code_quality",
      description:
        "Is the code well-structured, readable, and maintainable? Does it " +
        "follow project conventions? Are there security vulnerabilities?",
      weight: 0.20,
      threshold: 0.5,
    },
    {
      name: "test_coverage",
      description:
        "Are changes covered by tests? Do tests verify actual behavior, " +
        "not just exercise code paths? Are edge cases tested?",
      weight: 0.20,
      threshold: 0.6,
    },
  ],
  passThreshold: 0.65,
};

export const DESIGN_REVIEW_RUBRIC: GradingRubric = {
  criteria: [
    {
      name: "design_quality",
      description:
        "Does the design feel like a coherent whole rather than a collection " +
        "of parts? Do colors, typography, layout combine to create a distinct identity?",
      weight: 0.30,
      threshold: 0.6,
    },
    {
      name: "originality",
      description:
        "Is there evidence of custom decisions? A human designer should recognize " +
        "deliberate creative choices. Unmodified stock components fail here.",
      weight: 0.25,
      threshold: 0.5,
    },
    {
      name: "craft",
      description:
        "Technical execution: typography hierarchy, spacing consistency, " +
        "color harmony, contrast ratios. A competence check.",
      weight: 0.20,
      threshold: 0.6,
    },
    {
      name: "functionality",
      description:
        "Usability independent of aesthetics. Can users understand the interface, " +
        "find primary actions, and complete tasks without guessing?",
      weight: 0.25,
      threshold: 0.7,
    },
  ],
  passThreshold: 0.60,
};

// ---------------------------------------------------------------------------
// Rubric registry
// ---------------------------------------------------------------------------

const RUBRIC_REGISTRY: Record<string, GradingRubric> = {
  default: DEFAULT_REVIEW_RUBRIC,
  design: DESIGN_REVIEW_RUBRIC,
};

/**
 * Get a rubric by name, falling back to default.
 */
export function getRubric(name: string = "default"): GradingRubric {
  return RUBRIC_REGISTRY[name] ?? DEFAULT_REVIEW_RUBRIC;
}

/**
 * Register a custom rubric.
 */
export function registerRubric(name: string, rubric: GradingRubric): void {
  RUBRIC_REGISTRY[name] = rubric;
}

// ---------------------------------------------------------------------------
// Scoring engine
// ---------------------------------------------------------------------------

/**
 * Evaluate grades against a rubric and produce a report.
 *
 * Each grade must include a score (0.0-1.0) and feedback.
 * The rubric determines weights, thresholds, and overall pass criteria.
 */
export function evaluateGrades(opts: {
  taskId: string;
  agentName: string;
  feature: string;
  rubric: GradingRubric;
  scores: Array<{ criterion: string; score: number; feedback: string }>;
}): GradingReport {
  const grades: GradeResult[] = [];
  let weightedSum = 0;
  let totalWeight = 0;
  let anyBelowThreshold = false;

  for (const criterion of opts.rubric.criteria) {
    const scoreEntry = opts.scores.find((s) => s.criterion === criterion.name);
    const score = scoreEntry?.score ?? 0;
    const feedback = scoreEntry?.feedback ?? "Not evaluated";
    const passed = score >= criterion.threshold;

    if (!passed) {
      anyBelowThreshold = true;
    }

    grades.push({
      criterion: criterion.name,
      score,
      weight: criterion.weight,
      threshold: criterion.threshold,
      passed,
      feedback,
    });

    weightedSum += score * criterion.weight;
    totalWeight += criterion.weight;
  }

  const weightedScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const overallPassed =
    !anyBelowThreshold && weightedScore >= opts.rubric.passThreshold;

  let verdict: "APPROVE" | "REQUEST_CHANGES" | "BLOCK";
  if (overallPassed) {
    verdict = "APPROVE";
  } else if (anyBelowThreshold) {
    const failedCriteria = grades.filter((g) => !g.passed);
    // BLOCK if more than half the criteria fail
    verdict = failedCriteria.length > grades.length / 2 ? "BLOCK" : "REQUEST_CHANGES";
  } else {
    verdict = "REQUEST_CHANGES";
  }

  const failedNames = grades
    .filter((g) => !g.passed)
    .map((g) => g.criterion);

  const summary =
    overallPassed
      ? `All criteria met. Weighted score: ${(weightedScore * 100).toFixed(1)}%`
      : `Failed criteria: ${failedNames.join(", ")}. Weighted score: ${(weightedScore * 100).toFixed(1)}%`;

  return {
    taskId: opts.taskId,
    agentName: opts.agentName,
    feature: opts.feature,
    grades,
    weightedScore,
    passed: overallPassed,
    verdict,
    summary,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Report I/O (file-based artifact)
// ---------------------------------------------------------------------------

/**
 * Write a grading report to disk as a file-based artifact.
 */
export function writeGradingReport(
  report: GradingReport,
  projectRoot: string = process.cwd(),
): string {
  const dir = join(projectRoot, REVIEWS_DIR, report.feature);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Write JSON for programmatic access
  const jsonPath = join(dir, `${report.agentName}-review.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");

  // Write markdown for human/agent readability
  const mdPath = join(dir, `${report.agentName}-review.md`);
  writeFileSync(mdPath, renderGradingReport(report), "utf-8");

  return jsonPath;
}

/**
 * Load a grading report from disk.
 */
export function loadGradingReport(
  feature: string,
  agentName: string,
  projectRoot: string = process.cwd(),
): GradingReport | null {
  const path = join(
    projectRoot,
    REVIEWS_DIR,
    feature,
    `${agentName}-review.json`,
  );
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as GradingReport;
  } catch {
    return null;
  }
}

/**
 * Render a grading report as markdown.
 */
export function renderGradingReport(report: GradingReport): string {
  const lines: string[] = [];

  lines.push(`# Review: ${report.agentName}`);
  lines.push("");
  lines.push(`**Task:** ${report.taskId}`);
  lines.push(`**Feature:** ${report.feature}`);
  lines.push(`**Verdict:** ${report.verdict}`);
  lines.push(`**Score:** ${(report.weightedScore * 100).toFixed(1)}%`);
  lines.push(`**Timestamp:** ${report.timestamp}`);
  lines.push("");

  lines.push("## Criteria Scores");
  lines.push("");
  lines.push("| Criterion | Score | Threshold | Weight | Result |");
  lines.push("|-----------|-------|-----------|--------|--------|");

  for (const g of report.grades) {
    const result = g.passed ? "PASS" : "FAIL";
    lines.push(
      `| ${g.criterion} | ${(g.score * 100).toFixed(0)}% | ${(g.threshold * 100).toFixed(0)}% | ${(g.weight * 100).toFixed(0)}% | ${result} |`,
    );
  }

  lines.push("");
  lines.push("## Detailed Feedback");
  lines.push("");

  for (const g of report.grades) {
    lines.push(`### ${g.criterion} ${g.passed ? "(PASS)" : "(FAIL)"}`);
    lines.push(g.feedback);
    lines.push("");
  }

  lines.push("## Summary");
  lines.push(report.summary);

  return lines.join("\n");
}

/**
 * Generate the grading criteria section for a reviewer's overlay.
 */
export function renderRubricForOverlay(rubric: GradingRubric): string {
  const lines: string[] = [];

  lines.push("## Grading Rubric");
  lines.push("");
  lines.push(
    "Score each criterion 0.0-1.0. If ANY criterion falls below its threshold, the sprint FAILS.",
  );
  lines.push(`Overall pass threshold: ${(rubric.passThreshold * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("| Criterion | Weight | Threshold | Description |");
  lines.push("|-----------|--------|-----------|-------------|");

  for (const c of rubric.criteria) {
    lines.push(
      `| ${c.name} | ${(c.weight * 100).toFixed(0)}% | ${(c.threshold * 100).toFixed(0)}% | ${c.description} |`,
    );
  }

  lines.push("");
  lines.push("Report your scores in this exact format in your result mail payload:");
  lines.push("```json");
  lines.push('{');
  lines.push('  "scores": [');
  for (let i = 0; i < rubric.criteria.length; i++) {
    const c = rubric.criteria[i];
    const comma = i < rubric.criteria.length - 1 ? "," : "";
    lines.push(
      `    { "criterion": "${c.name}", "score": 0.0, "feedback": "..." }${comma}`,
    );
  }
  lines.push("  ]");
  lines.push('}');
  lines.push("```");

  return lines.join("\n");
}
