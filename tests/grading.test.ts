import { describe, it, expect } from "vitest";
import {
  getRubric,
  evaluateGrades,
  DEFAULT_REVIEW_RUBRIC,
  DESIGN_REVIEW_RUBRIC,
  renderGradingReport,
  renderRubricForOverlay,
} from "../src/grading.js";

describe("getRubric", () => {
  it("returns default rubric", () => {
    const rubric = getRubric("default");
    expect(rubric.criteria).toHaveLength(4);
    expect(rubric.criteria[0].name).toBe("functionality");
  });

  it("returns design rubric", () => {
    const rubric = getRubric("design");
    expect(rubric.criteria[0].name).toBe("design_quality");
  });

  it("falls back to default for unknown name", () => {
    const rubric = getRubric("nonexistent");
    expect(rubric).toEqual(DEFAULT_REVIEW_RUBRIC);
  });
});

describe("evaluateGrades", () => {
  it("approves when all criteria pass", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 0.9, feedback: "All features work" },
        { criterion: "completeness", score: 0.8, feedback: "No stubs" },
        { criterion: "code_quality", score: 0.85, feedback: "Clean code" },
        { criterion: "test_coverage", score: 0.75, feedback: "Good coverage" },
      ],
    });

    expect(report.verdict).toBe("APPROVE");
    expect(report.passed).toBe(true);
    expect(report.weightedScore).toBeGreaterThan(0.65);
    expect(report.grades).toHaveLength(4);
  });

  it("rejects when a criterion falls below threshold", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 0.5, feedback: "Core broken" },
        { criterion: "completeness", score: 0.8, feedback: "OK" },
        { criterion: "code_quality", score: 0.7, feedback: "OK" },
        { criterion: "test_coverage", score: 0.7, feedback: "OK" },
      ],
    });

    expect(report.verdict).toBe("REQUEST_CHANGES");
    expect(report.passed).toBe(false);
    expect(report.grades.find((g) => g.criterion === "functionality")!.passed).toBe(false);
  });

  it("blocks when majority of criteria fail", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 0.2, feedback: "Broken" },
        { criterion: "completeness", score: 0.3, feedback: "Mostly stubs" },
        { criterion: "code_quality", score: 0.2, feedback: "Bad" },
        { criterion: "test_coverage", score: 0.7, feedback: "OK" },
      ],
    });

    expect(report.verdict).toBe("BLOCK");
    expect(report.passed).toBe(false);
  });

  it("handles missing scores as zero", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 0.9, feedback: "Good" },
        // Missing: completeness, code_quality, test_coverage
      ],
    });

    expect(report.passed).toBe(false);
    const missing = report.grades.filter((g) => g.score === 0);
    expect(missing).toHaveLength(3);
  });

  it("calculates weighted score correctly", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 1.0, feedback: "Perfect" },
        { criterion: "completeness", score: 1.0, feedback: "Perfect" },
        { criterion: "code_quality", score: 1.0, feedback: "Perfect" },
        { criterion: "test_coverage", score: 1.0, feedback: "Perfect" },
      ],
    });

    expect(report.weightedScore).toBeCloseTo(1.0);
  });
});

describe("renderGradingReport", () => {
  it("renders as markdown with table", () => {
    const report = evaluateGrades({
      taskId: "cn-abc",
      agentName: "builder-1",
      feature: "auth",
      rubric: DEFAULT_REVIEW_RUBRIC,
      scores: [
        { criterion: "functionality", score: 0.9, feedback: "Works well" },
        { criterion: "completeness", score: 0.8, feedback: "Complete" },
        { criterion: "code_quality", score: 0.7, feedback: "Clean" },
        { criterion: "test_coverage", score: 0.7, feedback: "Covered" },
      ],
    });

    const md = renderGradingReport(report);
    expect(md).toContain("# Review: builder-1");
    expect(md).toContain("| Criterion |");
    expect(md).toContain("functionality");
    expect(md).toContain("PASS");
  });
});

describe("renderRubricForOverlay", () => {
  it("renders rubric for overlay injection", () => {
    const overlay = renderRubricForOverlay(DEFAULT_REVIEW_RUBRIC);
    expect(overlay).toContain("## Grading Rubric");
    expect(overlay).toContain("functionality");
    expect(overlay).toContain("threshold");
    expect(overlay).toContain('"scores"');
  });
});
