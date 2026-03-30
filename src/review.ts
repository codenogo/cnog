/**
 * Review scope construction and evaluation-spec building.
 *
 * Evaluation is run-scoped and artifact-driven. The evaluator should only see
 * the exact immutable scope under review, never feature-scoped leftovers.
 */

import { createHash, randomUUID } from "node:crypto";
import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { ArtifactRow } from "./types.js";
import type { Lifecycle } from "./lifecycle.js";
import { persistJsonArtifact } from "./artifacts.js";
import { evaluateGrades, getRubric, renderGradingReport } from "./grading.js";
import type { GradingRubric, SprintContract } from "./types.js";
import { loadLatestPlan } from "./planning/plan-factory.js";
import { ContractManager, loadContractFromArtifact } from "./contracts.js";

export interface EvaluationSpec {
  taskPrompt: string;
  verifyCommands: string[];
  rubric?: GradingRubric;
  reviewKind: "contract" | "implementation";
  contractIds?: string[];
}

interface EvaluationMessageLike {
  subject: string;
  body?: string | null;
  payload?: Record<string, unknown> | null;
}

interface ScopedContract {
  artifact: ArtifactRow;
  contract: SprintContract;
}

interface ScopeSnapshot {
  mergeEntryIds: number[];
  branches: string[];
  headShas: string[];
  contractIds: string[];
  contractHashes: string[];
  contractArtifacts: ArtifactRow[];
  verifyCommands: string[];
}

interface PendingContractSnapshot {
  artifact: ArtifactRow;
  contract: SprintContract;
}

interface ContractReviewDecision {
  contractId: string;
  decision: string;
  notes?: string;
}

/**
 * Compute a deterministic scope hash from immutable scope components.
 */
export function computeScopeHash(opts: {
  mergeEntryIds: number[];
  branches: string[];
  headShas: string[];
  contractIds: string[];
  contractHashes: string[];
  verifyCommands: string[];
}): string {
  const canonical = JSON.stringify({
    mergeEntryIds: [...opts.mergeEntryIds].sort((a, b) => a - b),
    branches: [...opts.branches].sort(),
    headShas: [...opts.headShas].sort(),
    contractIds: [...opts.contractIds].sort(),
    contractHashes: [...opts.contractHashes].sort(),
    verifyCommands: [...opts.verifyCommands].sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function latestAcceptedContractForIssue(
  db: CnogDB,
  issueId: string,
  projectRoot: string,
): ScopedContract | null {
  const artifacts = db.artifacts
    .listByIssue(issueId)
    .filter((artifact) => artifact.type === "contract");

  for (let i = artifacts.length - 1; i >= 0; i--) {
    const contract = loadContractFromArtifact(artifacts[i], projectRoot);
    if (!contract) continue;
    if (contract.status === "accepted" || contract.status === "completed") {
      return { artifact: artifacts[i], contract };
    }
  }

  return null;
}

function latestPendingContractForIssue(
  db: CnogDB,
  issueId: string,
  projectRoot: string,
): PendingContractSnapshot | null {
  const artifacts = db.artifacts
    .listByIssue(issueId)
    .filter((artifact) => artifact.type === "contract");

  for (let i = artifacts.length - 1; i >= 0; i--) {
    const contract = loadContractFromArtifact(artifacts[i], projectRoot);
    if (!contract) continue;
    if (contract.status === "pending_review") {
      return { artifact: artifacts[i], contract };
    }
    if (contract.status === "accepted" || contract.status === "completed") {
      return null;
    }
  }

  return null;
}

function collectScopeSnapshot(
  runId: string,
  db: CnogDB,
  projectRoot: string,
  overrideVerifyCommands?: string[],
): ScopeSnapshot {
  const pending = db.merges.pendingForRun(runId);
  const contracts: ScopedContract[] = [];

  for (const entry of pending) {
    if (!entry.task_id) continue;
    const scoped = latestAcceptedContractForIssue(db, entry.task_id, projectRoot);
    if (scoped) {
      contracts.push(scoped);
    }
  }

  const contractArtifacts = unique(
    contracts.map((scoped) => scoped.artifact.id),
  ).map((id) => contracts.find((scoped) => scoped.artifact.id === id)!.artifact);

  const verifyCommands = overrideVerifyCommands
    ? unique(overrideVerifyCommands)
    : unique(contracts.flatMap((scoped) => scoped.contract.verifyCommands));

  return {
    mergeEntryIds: pending.map((entry) => entry.id),
    branches: pending.map((entry) => entry.branch),
    headShas: pending.map((entry) => entry.head_sha),
    contractIds: contractArtifacts.map((artifact) => artifact.id),
    contractHashes: contractArtifacts.map((artifact) => artifact.hash),
    contractArtifacts,
    verifyCommands,
  };
}

/**
 * Compute the current hashable review scope for a run from live pending state.
 */
export function computeCurrentScopeHash(
  runId: string,
  db: CnogDB,
  projectRoot: string = process.cwd(),
): string {
  const snapshot = collectScopeSnapshot(runId, db, projectRoot);
  return computeScopeHash(snapshot);
}

/**
 * Build a review scope for a run, capturing the exact pending merge entries
 * and the latest accepted contract versions for those entries.
 *
 * Creates and persists the review_scope row. Returns the scope ID.
 */
export function buildReviewScope(opts: {
  runId: string;
  feature: string;
  db: CnogDB;
  projectRoot?: string;
  verifyCommands?: string[];
}): string {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const snapshot = collectScopeSnapshot(
    opts.runId,
    opts.db,
    projectRoot,
    opts.verifyCommands,
  );

  const scopeHash = computeScopeHash(snapshot);
  const scopeId = `scope-${randomUUID().slice(0, 8)}`;

  opts.db.reviewScopes.create({
    id: scopeId,
    run_id: opts.runId,
    scope_status: "pending",
    scope_hash: scopeHash,
    merge_entries: JSON.stringify(snapshot.mergeEntryIds),
    branches: JSON.stringify(snapshot.branches),
    head_shas: JSON.stringify(snapshot.headShas),
    contract_ids: JSON.stringify(snapshot.contractIds),
    contract_hashes: JSON.stringify(snapshot.contractHashes),
    verify_commands: JSON.stringify(snapshot.verifyCommands),
    verdict: null,
    evaluator_session: null,
  });

  persistJsonArtifact({
    db: opts.db,
    artifactId: `art-${scopeId}`,
    runId: opts.runId,
    feature: opts.feature,
    type: "review-scope",
    filename: `${scopeId}.json`,
    data: {
      id: scopeId,
      runId: opts.runId,
      feature: opts.feature,
      scopeHash,
      mergeEntryIds: snapshot.mergeEntryIds,
      branches: snapshot.branches,
      headShas: snapshot.headShas,
      contractIds: snapshot.contractIds,
      contractHashes: snapshot.contractHashes,
      verifyCommands: snapshot.verifyCommands,
      createdAt: new Date().toISOString(),
    },
    projectRoot,
    reviewScopeId: scopeId,
  });

  return scopeId;
}

/**
 * Build the evaluator prompt for an exact run-scoped review scope.
 */
export function buildRunEvaluationSpec(opts: {
  runId: string;
  scopeId: string;
  db: CnogDB;
  canonicalBranch: string;
  projectRoot?: string;
}): EvaluationSpec {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const run = opts.db.runs.get(opts.runId);
  if (!run) {
    throw new Error(`Run ${opts.runId} not found`);
  }

  const scope = opts.db.reviewScopes.get(opts.scopeId);
  if (!scope || scope.run_id !== run.id) {
    throw new Error(`Review scope ${opts.scopeId} not found for run ${opts.runId}`);
  }

  const plan = loadLatestPlan(run.feature, projectRoot);
  const branches = JSON.parse(scope.branches) as string[];
  const contractArtifactIds = JSON.parse(scope.contract_ids) as string[];
  const verifyCommands = JSON.parse(scope.verify_commands) as string[];
  const contractArtifacts = contractArtifactIds
    .map((id) => opts.db.artifacts.get(id))
    .filter((artifact): artifact is ArtifactRow => !!artifact);

  const lines: string[] = [];
  lines.push(`Evaluate the exact candidate scope for feature ${run.feature}.`);
  lines.push("");
  lines.push(`Run: ${run.id}`);
  lines.push(`Scope: ${scope.id}`);
  lines.push(`Scope Hash: ${scope.scope_hash}`);

  if (plan?.goal) {
    lines.push("");
    lines.push(`Feature goal: ${plan.goal}`);
  }

  if (branches.length > 0) {
    lines.push("");
    lines.push(`Compare these pending branches against ${opts.canonicalBranch}:`);
    for (const branch of branches) {
      lines.push(`- ${branch}`);
    }
    lines.push("");
    lines.push(
      `Use \`git diff ${opts.canonicalBranch}...<branch>\` and inspect the branch contents before grading.`,
    );
  }

  if (contractArtifacts.length > 0) {
    lines.push("");
    lines.push("Consult these accepted contract artifacts while evaluating:");
    for (const artifact of contractArtifacts) {
      lines.push(`- ${artifact.path} (${artifact.hash})`);
    }
  }

  lines.push("");
  lines.push("This verdict applies only to the scope hash above.");
  lines.push("Run every verify command listed in the overlay.");
  lines.push("Return APPROVE, REQUEST_CHANGES, or BLOCK.");
  lines.push("Include structured scores in the result payload.");

  return {
    taskPrompt: lines.join("\n"),
    verifyCommands,
    rubric: getRubric("default"),
    reviewKind: "implementation",
  };
}

export function buildContractEvaluationSpec(opts: {
  runId: string;
  feature: string;
  db: CnogDB;
  projectRoot?: string;
}): EvaluationSpec {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const run = opts.db.runs.get(opts.runId);
  if (!run) {
    throw new Error(`Run ${opts.runId} not found`);
  }

  const pendingContracts = opts.db.issues
    .list({ run_id: run.id })
    .map((issue) => latestPendingContractForIssue(opts.db, issue.id, projectRoot))
    .filter((entry): entry is PendingContractSnapshot => !!entry);

  if (pendingContracts.length === 0) {
    throw new Error(`Run ${opts.runId} has no pending contracts to evaluate`);
  }

  const plan = loadLatestPlan(run.feature, projectRoot);
  const lines: string[] = [];
  lines.push(`Evaluate the pending sprint contracts for feature ${run.feature}.`);
  lines.push("");
  lines.push(`Run: ${run.id}`);

  if (plan?.goal) {
    lines.push(`Feature goal: ${plan.goal}`);
    lines.push("");
  }

  lines.push("Review each proposed contract artifact below before any builder starts:");
  for (const entry of pendingContracts) {
    lines.push(`- ${entry.contract.id}: ${entry.artifact.path} (${entry.artifact.hash})`);
  }

  lines.push("");
  lines.push("For every listed contract, decide ACCEPT or REJECT.");
  lines.push("Reject contracts when the file scope, acceptance criteria, or verify commands are wrong or incomplete.");
  lines.push("Return a structured result payload with one decision per contract.");
  lines.push('Use decisions "ACCEPT" or "REJECT" and include notes for each contract.');

  return {
    taskPrompt: lines.join("\n"),
    verifyCommands: [],
    reviewKind: "contract",
    contractIds: pendingContracts.map((entry) => entry.contract.id),
  };
}

export function buildImplementationReviewCompletionCommand(agentName: string): string {
  const payload = JSON.stringify({
    kind: "implementation_review",
    verdict: "<VERDICT>",
    reworkPhase: "build",
    scores: [{ criterion: "functionality", score: 0.0, feedback: "..." }],
  });
  return `cnog mail send orchestrator "review: <VERDICT>" --from ${agentName} --type result --payload '${payload}'`;
}

export function buildContractReviewCompletionCommand(
  agentName: string,
  contractIds: string[],
): string {
  const payload = JSON.stringify({
    kind: "contract_review",
    contracts: contractIds.map((contractId) => ({
      contractId,
      decision: "ACCEPT",
      notes: "...",
    })),
  });
  return `cnog mail send orchestrator "contract review complete" --from ${agentName} --type result --payload '${payload}'`;
}

export function extractEvaluationVerdict(msg: EvaluationMessageLike): string | null {
  if (msg.payload?.verdict) {
    return String(msg.payload.verdict).toUpperCase();
  }

  const text = `${msg.subject} ${msg.body ?? ""}`;
  const match = text.match(/\b(APPROVE|REQUEST_CHANGES|BLOCK)\b/i);
  return match ? match[1].toUpperCase() : null;
}

function extractReworkPhase(
  msg: EvaluationMessageLike,
  verdict: string,
): "build" | "contract" {
  const explicit = msg.payload?.reworkPhase ?? msg.payload?.nextPhase;
  if (explicit === "build" || explicit === "contract") {
    return explicit;
  }
  return verdict === "BLOCK" ? "contract" : "build";
}

function extractContractReviewDecisions(msg: EvaluationMessageLike): ContractReviewDecision[] {
  const payloadContracts = msg.payload?.contracts;
  if (!Array.isArray(payloadContracts)) return [];
  return payloadContracts.filter((decision): decision is ContractReviewDecision => (
    !!decision
    && typeof decision === "object"
    && typeof (decision as ContractReviewDecision).contractId === "string"
    && typeof (decision as ContractReviewDecision).decision === "string"
  ));
}

export function isContractReviewMessage(msg: EvaluationMessageLike): boolean {
  if (msg.payload?.kind === "contract_review") return true;
  return extractContractReviewDecisions(msg).length > 0;
}

export function applyContractReviewResult(opts: {
  runId: string;
  sessionId: string;
  sessionName: string;
  feature: string;
  message: EvaluationMessageLike;
  db: CnogDB;
  events: EventEmitter;
  projectRoot?: string;
}): number {
  const run = opts.db.runs.get(opts.runId);
  if (!run || run.status !== "contract") return 0;

  const decisions = extractContractReviewDecisions(opts.message);
  if (decisions.length === 0) return 0;

  const projectRoot = opts.projectRoot ?? process.cwd();
  const contracts = new ContractManager(opts.db, opts.events, projectRoot);
  const processed: Array<{ contractId: string; decision: "ACCEPT" | "REJECT"; notes: string | null }> = [];

  for (const decision of decisions) {
    const normalized = decision.decision.toUpperCase();
    const notes = decision.notes ?? null;
    if (normalized === "ACCEPT") {
      const accepted = contracts.accept(decision.contractId, opts.feature, opts.sessionName, notes ?? undefined);
      if (accepted) {
        processed.push({ contractId: decision.contractId, decision: "ACCEPT", notes });
      }
      continue;
    }
    if (normalized === "REJECT") {
      const rejected = contracts.reject(
        decision.contractId,
        opts.feature,
        opts.sessionName,
        notes ?? "Rejected during contract review",
      );
      if (rejected) {
        processed.push({ contractId: decision.contractId, decision: "REJECT", notes });
      }
    }
  }

  if (processed.length === 0) return 0;

  const nonce = Date.now();
  persistJsonArtifact({
    db: opts.db,
    artifactId: `art-contract-review-${run.id}-${opts.sessionId}-${nonce}`,
    runId: run.id,
    feature: opts.feature,
    type: "review-report",
    filename: `contract-review-${run.id}-${opts.sessionId}-${nonce}.json`,
    data: {
      kind: "contract_review",
      runId: run.id,
      feature: opts.feature,
      evaluatorSession: opts.sessionId,
      evaluatorName: opts.sessionName,
      decisions: processed,
      subject: opts.message.subject,
      body: opts.message.body ?? null,
      reviewedAt: new Date().toISOString(),
    },
    projectRoot,
    sessionId: opts.sessionId,
  });

  const rejectedCount = processed.filter((decision) => decision.decision === "REJECT").length;
  opts.db.runs.update(run.id, {
    phase_reason: rejectedCount > 0
      ? "Contract review requested changes"
      : "Pending contracts approved by evaluator",
  });
  opts.events.emit({
    source: "review",
    eventType: "contract_review_completed",
    message: `Evaluator reviewed ${processed.length} contract(s) for run ${run.id}`,
    feature: opts.feature,
    agentName: opts.sessionName,
    data: { runId: run.id, processed: processed.length, rejected: rejectedCount },
  });

  return processed.length;
}

export function applyEvaluationResult(opts: {
  runId: string;
  sessionId: string;
  sessionName: string;
  feature: string;
  message: EvaluationMessageLike;
  db: CnogDB;
  events: EventEmitter;
  lifecycle: Lifecycle;
  projectRoot?: string;
}): string | null {
  const run = opts.db.runs.get(opts.runId);
  if (!run) return null;
  if (run.status !== "evaluate") return null;

  let verdict: string | null = null;
  let gradingReport: ReturnType<typeof evaluateGrades> | null = null;

  if (opts.message.payload?.scores && Array.isArray(opts.message.payload.scores)) {
    const rubric = getRubric("default");
    gradingReport = evaluateGrades({
      taskId: "",
      agentName: opts.sessionName,
      feature: opts.feature,
      rubric,
      scores: opts.message.payload.scores as Array<{
        criterion: string;
        score: number;
        feedback: string;
      }>,
    });
    verdict = gradingReport.verdict;
  } else {
    verdict = extractEvaluationVerdict(opts.message);
  }

  if (!verdict) return null;

  const activeScope = opts.db.reviewScopes.activeForRun(run.id);
  if (!activeScope) return verdict;

  const artifactNonce = Date.now();
  const reviewReportArtifact = persistJsonArtifact({
    db: opts.db,
    artifactId: `art-review-${activeScope.id}-${opts.sessionId}-${artifactNonce}`,
    runId: run.id,
    feature: opts.feature,
    type: "review-report",
    filename: `review-report-${activeScope.id}-${opts.sessionId}-${artifactNonce}.json`,
    data: {
      runId: run.id,
      scopeId: activeScope.id,
      scopeHash: activeScope.scope_hash,
      feature: opts.feature,
      evaluatorSession: opts.sessionId,
      evaluatorName: opts.sessionName,
      verdict,
      subject: opts.message.subject,
      body: opts.message.body ?? null,
      payload: opts.message.payload ?? null,
      evaluatedAt: new Date().toISOString(),
    },
    projectRoot: opts.projectRoot,
    sessionId: opts.sessionId,
    reviewScopeId: activeScope.id,
  });

  let gradingArtifactId: string | null = null;
  opts.db.reviewScopes.setVerdict(activeScope.id, verdict, opts.sessionId);

  let shouldPersistFeatureVerdict = false;
  if (verdict === "APPROVE" && run.status === "evaluate") {
    try {
      opts.lifecycle.advanceRun(run.id, "merge", "Evaluation approved exact review scope");
      shouldPersistFeatureVerdict = true;
    } catch {
      // Leave the accepted scope recorded even if another actor already advanced.
    }
  } else {
    const targetPhase = extractReworkPhase(opts.message, verdict);
    try {
      opts.lifecycle.advanceRun(
        run.id,
        targetPhase,
        targetPhase === "contract"
          ? "Evaluation blocked; contract needs revision"
          : "Evaluation requested implementation rework",
      );
    } catch {
      // Keep the rejected scope recorded even if another actor already moved the run.
    }
  }

  if (gradingReport) {
    gradingReport = { ...gradingReport, taskId: activeScope.id };
    const gradingArtifact = persistJsonArtifact({
      db: opts.db,
      artifactId: `art-grading-${activeScope.id}-${opts.sessionId}-${artifactNonce}`,
      runId: run.id,
      feature: opts.feature,
      type: "grading-report",
      filename: `grading-report-${activeScope.id}-${opts.sessionId}-${artifactNonce}.json`,
      data: gradingReport,
      markdown: renderGradingReport(gradingReport),
      projectRoot: opts.projectRoot,
      sessionId: opts.sessionId,
      reviewScopeId: activeScope.id,
    });
    gradingArtifactId = gradingArtifact.id;
  }

  opts.db.reviewAttempts.create({
    scope_id: activeScope.id,
    evaluator_session: opts.sessionId,
    verdict,
    report_artifact_id: reviewReportArtifact.id,
    grading_artifact_id: gradingArtifactId,
    completed_at: new Date().toISOString(),
  });
  opts.events.scopeEvaluated(activeScope.id, verdict, opts.feature);
  if (shouldPersistFeatureVerdict) {
    opts.db.phases.setVerdict(opts.feature, verdict);
  }

  return verdict;
}
