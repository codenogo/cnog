import { mkdirSync } from "node:fs";

import type { CnogDB } from "./db.js";
import { extractResumeContext, loadCheckpoint, type CheckpointSelector } from "./checkpoint.js";
import {
  runScratchAgentDir,
  runScratchDir,
  runScratchRoleDir,
  runScratchSharedDir,
} from "./paths.js";
import type { SprintContract } from "./types.js";
import type { WorkerAssignmentSpec } from "./prompt-contract.js";

export interface WorkerContextLayer {
  id:
    | "git_snapshot"
    | "run_phase"
    | "assignment_context"
    | "dependency_branches"
    | "contracts"
    | "prior_reviews"
    | "checkpoint"
    | "scratchpad";
  title: string;
  bullets: string[];
  body?: string;
}

export interface WorkerScratchpadPaths {
  root: string;
  shared: string;
  role: string;
  agent: string;
}

export interface WorkerContextBundle {
  bundleVersion: 1;
  workspaceRoot: string;
  worktreePath: string;
  scratchpad: WorkerScratchpadPaths;
  layers: WorkerContextLayer[];
}

function codeBlock(title: string, content: string | null): string | undefined {
  const trimmed = content?.trim();
  if (!trimmed) return undefined;
  return `#### ${title}\n\`\`\`text\n${trimmed}\n\`\`\``;
}

function latestContractReference(
  db: CnogDB,
  issueId: string | undefined,
): { path: string; hash?: string | null } | null {
  if (!issueId) return null;
  const artifact = db.artifacts
    .listByIssue(issueId)
    .filter((entry) => entry.type === "contract")
    .at(-1);
  if (!artifact) return null;
  return { path: artifact.path, hash: artifact.hash };
}

function checkpointLayer(opts: {
  db: CnogDB;
  selector: CheckpointSelector;
  projectRoot: string;
}): WorkerContextLayer | null {
  const checkpoint = loadCheckpoint(opts.db, opts.selector, opts.projectRoot);
  if (!checkpoint) return null;
  const resume = extractResumeContext(checkpoint);

  const bodyParts = [
    codeBlock("Transcript Tail", resume.transcriptTail),
    codeBlock("Task Log Tail", resume.taskLogTail),
  ].filter((part): part is string => !!part);
  if (resume.recentActivities.length > 0) {
    bodyParts.push([
      "#### Recent Activities",
      ...resume.recentActivities.slice(-5).map((activity) => `- ${activity.at} [${activity.kind}] ${activity.summary}`),
    ].join("\n"));
  }

  return {
    id: "checkpoint",
    title: "Checkpoint & Resume Context",
    bullets: [
      `Latest checkpoint summary: ${checkpoint.progressSummary}`,
      checkpoint.pendingWork ? `Pending work: ${checkpoint.pendingWork}` : "Pending work: none recorded",
      checkpoint.currentBranch ? `Previous branch: ${checkpoint.currentBranch}` : "Previous branch: not recorded",
      resume.transcriptPath ? `Transcript path: ${resume.transcriptPath}` : "Transcript path: unavailable",
      resume.taskLogPath ? `Task log path: ${resume.taskLogPath}` : "Task log path: unavailable",
      `Last activity: ${resume.lastActivitySummary ?? "-"}`,
      `Tool uses: ${resume.toolUseCount}`,
      `Duration: ${resume.durationMs ?? 0}ms`,
      `Scratchpad (shared): ${resume.scratchpad.shared ?? "-"}`,
    ],
    body: bodyParts.length > 0 ? bodyParts.join("\n\n") : undefined,
  };
}

function priorReviewsLayer(db: CnogDB, runId: string, currentScopeId?: string): WorkerContextLayer | null {
  const scopes = db.reviewScopes
    .listByRun(runId)
    .filter((scope) => scope.id !== currentScopeId && !!scope.verdict)
    .slice(-3);
  const artifacts = db.artifacts
    .listByRun(runId)
    .filter((artifact) => artifact.type === "grading-report" || artifact.type === "review-report")
    .slice(-3);

  if (scopes.length === 0 && artifacts.length === 0) return null;

  const bullets = [
    ...scopes.map((scope) => `Scope ${scope.id}: ${scope.verdict ?? "no verdict"} (${scope.scope_status})`),
    ...artifacts.map((artifact) => `${artifact.type}: ${artifact.path}${artifact.hash ? ` (${artifact.hash})` : ""}`),
  ];

  return {
    id: "prior_reviews",
    title: "Prior Review Results",
    bullets,
  };
}

function contractsLayer(opts: {
  assignment: WorkerAssignmentSpec;
  contract?: SprintContract;
  db: CnogDB;
  issueId?: string;
}): WorkerContextLayer | null {
  switch (opts.assignment.kind) {
    case "builder_assignment": {
      const latest = latestContractReference(opts.db, opts.issueId);
      if (!opts.contract && !latest) return null;
      return {
        id: "contracts",
        title: "Contract Inputs",
        bullets: [
          opts.contract
            ? `Accepted contract scope: ${opts.contract.fileScope.join(", ") || "none declared"}`
            : "Accepted contract scope: unavailable",
          opts.contract
            ? `Accepted verify commands: ${opts.contract.verifyCommands.join(" | ") || "none declared"}`
            : "Accepted verify commands: unavailable",
          latest
            ? `Latest contract artifact: ${latest.path}${latest.hash ? ` (${latest.hash})` : ""}`
            : "Latest contract artifact: unavailable",
        ],
      };
    }
    case "contract_review_assignment":
      return {
        id: "contracts",
        title: "Contract Inputs",
        bullets: opts.assignment.contracts.length > 0
          ? opts.assignment.contracts.map((contract) => (
            `${contract.path}${contract.hash ? ` (${contract.hash})` : ""}`
          ))
          : ["No pending contract artifacts supplied."],
      };
    case "implementation_review_assignment":
      return {
        id: "contracts",
        title: "Contract & Verification Inputs",
        bullets: [
          ...(opts.assignment.contractArtifacts.length > 0
            ? opts.assignment.contractArtifacts.map((artifact) => (
              `Accepted contract: ${artifact.path}${artifact.hash ? ` (${artifact.hash})` : ""}`
            ))
            : ["Accepted contract artifacts: none supplied"]),
          ...(opts.assignment.verifyArtifacts.length > 0
            ? opts.assignment.verifyArtifacts.map((artifact) => (
              `Verification artifact: ${artifact.path}${artifact.hash ? ` (${artifact.hash})` : ""}`
            ))
            : ["Verification artifacts: none supplied"]),
        ],
      };
    default:
      return null;
  }
}

function dependencyLayer(branches: string[]): WorkerContextLayer | null {
  if (branches.length === 0) return null;
  return {
    id: "dependency_branches",
    title: "Dependency Branches",
    bullets: branches,
  };
}

function assignmentContextLayer(assignment: WorkerAssignmentSpec): WorkerContextLayer {
  switch (assignment.kind) {
    case "builder_assignment":
      return {
        id: "assignment_context",
        title: "Builder Assignment Context",
        bullets: [
          `Plan task: ${assignment.planTaskKey} (#${assignment.taskIndex + 1})`,
          `Task name: ${assignment.taskName}`,
          assignment.planGoal ? `Plan goal: ${assignment.planGoal}` : "Plan goal: not declared",
          `File scope: ${assignment.fileScope.join(", ") || "none declared"}`,
          `Canonical verify commands: ${assignment.canonicalVerifyCommands.join(" | ") || "none declared"}`,
          `Context links: ${assignment.contextLinks.join(", ") || "none declared"}`,
        ],
        body: [
          "Action:",
          assignment.action,
          "",
          "Micro steps:",
          ...(assignment.microSteps.length > 0 ? assignment.microSteps.map((step) => `- ${step}`) : ["- No micro steps declared."]),
        ].join("\n"),
      };
    case "contract_review_assignment":
      return {
        id: "assignment_context",
        title: "Contract Review Context",
        bullets: [
          assignment.planGoal ? `Plan goal: ${assignment.planGoal}` : "Plan goal: not declared",
          `Pending contracts: ${assignment.contracts.length}`,
          ...assignment.contracts.map((contract) => (
            `${contract.title ?? contract.id ?? "contract"}: ${contract.path}${contract.hash ? ` (${contract.hash})` : ""}`
          )),
        ],
      };
    case "implementation_review_assignment":
      return {
        id: "assignment_context",
        title: "Implementation Review Context",
        bullets: [
          `Scope: ${assignment.scopeId}`,
          `Scope hash: ${assignment.scopeHash}`,
          `Candidate branches: ${assignment.branches.join(", ") || "none declared"}`,
          `Accepted contracts: ${assignment.contractArtifacts.length}`,
          `Verification artifacts: ${assignment.verifyArtifacts.length}`,
          `Rubric criteria: ${assignment.rubric.criteria.map((criterion) => criterion.name).join(", ")}`,
        ],
      };
    case "planner_assignment":
      return {
        id: "assignment_context",
        title: "Planner Assignment Context",
        bullets: [
          `Output path: ${assignment.outputPath}`,
          `Guidance items: ${assignment.guidance.length}`,
          ...(assignment.guidance.length > 0 ? assignment.guidance : ["No additional guidance."]),
        ],
      };
    case "generic_assignment":
      return {
        id: "assignment_context",
        title: "Generic Assignment Context",
        bullets: [assignment.details],
      };
  }
}

export function ensureWorkerScratchpadPaths(opts: {
  feature: string;
  runId: string;
  role: string;
  agentName: string;
  projectRoot: string;
}): WorkerScratchpadPaths {
  const scratchpad = {
    root: runScratchDir(opts.feature, opts.runId, opts.projectRoot),
    shared: runScratchSharedDir(opts.feature, opts.runId, opts.projectRoot),
    role: runScratchRoleDir(opts.feature, opts.runId, opts.role, opts.projectRoot),
    agent: runScratchAgentDir(opts.feature, opts.runId, opts.role, opts.agentName, opts.projectRoot),
  };
  mkdirSync(scratchpad.shared, { recursive: true });
  mkdirSync(scratchpad.role, { recursive: true });
  mkdirSync(scratchpad.agent, { recursive: true });
  return scratchpad;
}

export function buildWorkerContextBundle(opts: {
  db: CnogDB;
  projectRoot: string;
  runId: string;
  feature: string;
  role: string;
  logicalName: string;
  worktreePath: string;
  scratchpad: WorkerScratchpadPaths;
  assignment: WorkerAssignmentSpec;
  canonicalBranch?: string;
  branch?: string | null;
  issueId?: string;
  reviewScopeId?: string;
  dependencyBranches?: string[];
  contract?: SprintContract;
}): WorkerContextBundle {
  const run = opts.db.runs.get(opts.runId);
  const layers: WorkerContextLayer[] = [];

  layers.push({
    id: "git_snapshot",
    title: "Git Snapshot",
    bullets: [
      `Workspace root: ${opts.projectRoot}`,
      `Worktree path: ${opts.worktreePath}`,
      opts.canonicalBranch ? `Canonical branch: ${opts.canonicalBranch}` : "Canonical branch: not declared",
      opts.branch ? `Agent branch: ${opts.branch}` : "Agent branch: not declared",
    ],
  });

  layers.push({
    id: "run_phase",
    title: "Run Phase",
    bullets: [
      run ? `Run ${run.id} is in phase ${run.status}` : `Run ${opts.runId} phase unavailable`,
      run?.phase_reason ? `Phase reason: ${run.phase_reason}` : "Phase reason: none recorded",
      run?.profile ? `Profile: ${run.profile}` : "Profile: default",
    ],
  });

  layers.push(assignmentContextLayer(opts.assignment));

  const dependency = dependencyLayer(opts.dependencyBranches ?? []);
  if (dependency) layers.push(dependency);

  const contracts = contractsLayer({
    assignment: opts.assignment,
    contract: opts.contract,
    db: opts.db,
    issueId: opts.issueId,
  });
  if (contracts) layers.push(contracts);

  const reviews = priorReviewsLayer(opts.db, opts.runId, opts.reviewScopeId);
  if (reviews) layers.push(reviews);

  const checkpoint = checkpointLayer({
    db: opts.db,
    selector: {
      runId: opts.runId,
      feature: opts.feature,
      logicalName: opts.logicalName,
    },
    projectRoot: opts.projectRoot,
  });
  if (checkpoint) layers.push(checkpoint);

  layers.push({
    id: "scratchpad",
    title: "Run Scratchpad",
    bullets: [
      `Shared notes: ${opts.scratchpad.shared}`,
      `Role notes: ${opts.scratchpad.role}`,
      `Agent notes: ${opts.scratchpad.agent}`,
    ],
    body: [
      "Treat the scratchpad as mutable coordination space for research and handoff notes.",
      "Artifacts, contracts, review reports, and execution task state remain authoritative.",
    ].join("\n"),
  });

  return {
    bundleVersion: 1,
    workspaceRoot: opts.projectRoot,
    worktreePath: opts.worktreePath,
    scratchpad: opts.scratchpad,
    layers,
  };
}

export function renderContextBundleMarkdown(bundle: WorkerContextBundle): string {
  const lines: string[] = [];
  lines.push("## Layered Context");
  lines.push("");
  lines.push(`- Workspace root: ${bundle.workspaceRoot}`);
  lines.push(`- Worktree path: ${bundle.worktreePath}`);
  lines.push(`- Scratchpad root: ${bundle.scratchpad.root}`);
  lines.push("");

  for (const layer of bundle.layers) {
    lines.push(`### ${layer.title}`);
    if (layer.bullets.length > 0) {
      lines.push(...layer.bullets.map((item) => `- ${item}`));
    }
    if (layer.body) {
      lines.push("");
      lines.push(layer.body);
    }
    lines.push("");
  }

  lines.push("```json");
  lines.push(JSON.stringify(bundle, null, 2));
  lines.push("```");
  return lines.join("\n");
}
