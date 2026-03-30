/**
 * Sprint contracts — bidirectional acceptance negotiation.
 *
 * Before a builder starts work, a contract is proposed defining:
 * - What "done" looks like (acceptance criteria)
 * - How success is verified (verify commands)
 * - File scope boundaries
 *
 * The evaluator pre-approves the contract before the builder starts.
 * This catches scope mismatches early, before code is written.
 *
 * Contracts are immutable artifacts. Every write creates a new artifact row.
 */

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

import { runArtifactDir } from "./paths.js";

import type {
  SprintContract,
  AcceptanceCriterion,
  ArtifactRow,
} from "./types.js";
import type { CnogDB } from "./db.js";
import type { EventEmitter } from "./events.js";
import type { PlanTask } from "./planning/plan-factory.js";

// ---------------------------------------------------------------------------
// Contract generation from plan tasks
// ---------------------------------------------------------------------------

/**
 * Generate a sprint contract from a plan task.
 * This is what the builder and evaluator negotiate before work begins.
 */
export function generateContract(opts: {
  task: PlanTask;
  feature: string;
  agentName: string;
  runId: string;
}): SprintContract {
  const criteria: AcceptanceCriterion[] = [];

  // Core criterion: task action must be implemented
  criteria.push({
    description: opts.task.action,
    testable: true,
  });

  // Micro-steps become individual criteria
  if (opts.task.microSteps) {
    for (const step of opts.task.microSteps) {
      criteria.push({
        description: step,
        testable: true,
      });
    }
  }

  // Each verify command is a criterion
  for (const cmd of opts.task.verify) {
    criteria.push({
      description: `Verify command passes: ${cmd}`,
      testable: true,
      verifyCommand: cmd,
    });
  }

  // TDD criteria
  if (opts.task.tdd?.required) {
    if (opts.task.tdd.failingVerify) {
      criteria.push({
        description: `TDD: Write failing test first (${opts.task.tdd.failingVerify})`,
        testable: true,
        verifyCommand: opts.task.tdd.failingVerify,
      });
    }
  }

  return {
    id: `contract-${randomUUID().slice(0, 8)}`,
    taskId: "",
    runId: opts.runId,
    feature: opts.feature,
    agentName: opts.agentName,
    acceptanceCriteria: criteria,
    verifyCommands: opts.task.verify,
    fileScope: opts.task.files,
    status: "proposed",
    proposedAt: new Date().toISOString(),
    reviewedBy: null,
    reviewedAt: null,
    reviewNotes: null,
  };
}

/**
 * Compute a deterministic hash of a contract for artifact integrity.
 */
export function hashContract(contract: SprintContract): string {
  const canonical = JSON.stringify({
    id: contract.id,
    taskId: contract.taskId,
    runId: contract.runId,
    feature: contract.feature,
    acceptanceCriteria: contract.acceptanceCriteria,
    verifyCommands: contract.verifyCommands,
    fileScope: contract.fileScope,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Load a contract payload from a registered artifact row.
 */
export function loadContractFromArtifact(
  artifact: ArtifactRow,
  projectRoot: string = process.cwd(),
): SprintContract | null {
  const fullPath = join(projectRoot, artifact.path);
  if (!existsSync(fullPath)) return null;

  try {
    return JSON.parse(readFileSync(fullPath, "utf-8")) as SprintContract;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contract lifecycle
// ---------------------------------------------------------------------------

export class ContractManager {
  constructor(
    private readonly db: CnogDB,
    private readonly events: EventEmitter,
    private readonly projectRoot: string = process.cwd(),
  ) {}

  /**
   * Propose a contract for a task. Writes the contract artifact,
   * registers it in the artifact table, and marks it pending_review.
   */
  propose(contract: SprintContract): SprintContract {
    contract.status = "pending_review";
    this.persistContractArtifact(contract);

    this.events.emit({
      source: "contracts",
      eventType: "contract_proposed",
      message: `Contract proposed for ${contract.agentName}: ${contract.acceptanceCriteria.length} criteria`,
      feature: contract.feature,
      agentName: contract.agentName,
      data: { contractId: contract.id, criteriaCount: contract.acceptanceCriteria.length },
    });

    return contract;
  }

  /**
   * Accept a contract — evaluator signs off on acceptance criteria.
   */
  accept(
    contractId: string,
    feature: string,
    reviewedBy: string,
    notes?: string,
  ): SprintContract | null {
    const contract = this.loadContract(contractId, feature);
    if (!contract) return null;

    contract.status = "accepted";
    contract.reviewedBy = reviewedBy;
    contract.reviewedAt = new Date().toISOString();
    contract.reviewNotes = notes ?? null;

    this.persistContractArtifact(contract);

    this.events.emit({
      source: "contracts",
      eventType: "contract_accepted",
      message: `Contract accepted for ${contract.agentName} by ${reviewedBy}`,
      feature,
      agentName: contract.agentName,
    });

    return contract;
  }

  /**
   * Reject a contract — evaluator finds issues with scope/criteria.
   */
  reject(
    contractId: string,
    feature: string,
    reviewedBy: string,
    notes: string,
  ): SprintContract | null {
    const contract = this.loadContract(contractId, feature);
    if (!contract) return null;

    contract.status = "rejected";
    contract.reviewedBy = reviewedBy;
    contract.reviewedAt = new Date().toISOString();
    contract.reviewNotes = notes;

    this.persistContractArtifact(contract);

    this.events.emit({
      source: "contracts",
      eventType: "contract_rejected",
      message: `Contract rejected for ${contract.agentName}: ${notes}`,
      level: "warn",
      feature,
      agentName: contract.agentName,
    });

    return contract;
  }

  /**
   * Mark a contract as completed (all criteria met).
   */
  complete(contractId: string, feature: string): SprintContract | null {
    const contract = this.loadContract(contractId, feature);
    if (!contract) return null;

    contract.status = "completed";
    this.persistContractArtifact(contract);
    return contract;
  }

  /**
   * Mark a contract as failed (criteria not met).
   */
  fail(contractId: string, feature: string): SprintContract | null {
    const contract = this.loadContract(contractId, feature);
    if (!contract) return null;

    contract.status = "failed";
    this.persistContractArtifact(contract);
    return contract;
  }

  /**
   * Load a contract from its run-scoped artifact path.
   */
  loadContract(
    contractId: string,
    feature: string,
  ): SprintContract | null {
    const latest = this.listContractArtifacts(contractId, feature).at(-1);
    if (!latest) return null;
    return loadContractFromArtifact(latest, this.projectRoot);
  }

  /**
   * Load the latest contract version for a specific issue.
   */
  loadLatestForIssue(issueId: string, feature: string): SprintContract | null {
    const artifacts = this.db.artifacts
      .listByIssue(issueId)
      .filter((artifact) => artifact.type === "contract" && artifact.feature === feature);

    for (let i = artifacts.length - 1; i >= 0; i--) {
      const contract = loadContractFromArtifact(artifacts[i], this.projectRoot);
      if (contract) {
        return contract;
      }
    }

    return null;
  }

  /**
   * Write contract artifact to run-scoped path.
   * Returns the relative path from project root.
   */
  private persistContractArtifact(contract: SprintContract): string {
    const version = this.listContractArtifacts(contract.id, contract.feature).length + 1;
    const dir = runArtifactDir(contract.feature, contract.runId, this.projectRoot);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const jsonFilename = `${contract.id}.v${version}.json`;
    const mdFilename = `${contract.id}.v${version}.md`;

    // JSON for programmatic access
    writeFileSync(
      join(dir, jsonFilename),
      JSON.stringify(contract, null, 2),
      "utf-8",
    );

    // Markdown for agent/human readability
    writeFileSync(
      join(dir, mdFilename),
      renderContractMd(contract),
      "utf-8",
    );

    const relativePath = join(".cnog", "features", contract.feature, "runs", contract.runId, jsonFilename);

    this.db.artifacts.create({
      id: `art-${contract.id}-v${version}`,
      run_id: contract.runId,
      feature: contract.feature,
      type: "contract",
      path: relativePath,
      hash: hashContract(contract),
      issue_id: contract.taskId || null,
      session_id: null,
      review_scope_id: null,
    });

    return relativePath;
  }

  private listContractArtifacts(contractId: string, feature: string): ArtifactRow[] {
    const prefix = `${contractId}.v`;
    return this.db.artifacts
      .listByFeature(feature)
      .filter((artifact) =>
        artifact.type === "contract"
        && basename(artifact.path).startsWith(prefix)
        && artifact.path.endsWith(".json"),
      );
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render a contract as markdown (for overlay injection or human review).
 */
export function renderContractMd(contract: SprintContract): string {
  const lines: string[] = [];

  lines.push(`# Sprint Contract: ${contract.id}`);
  lines.push("");
  lines.push(`**Agent:** ${contract.agentName}`);
  lines.push(`**Feature:** ${contract.feature}`);
  lines.push(`**Run:** ${contract.runId}`);
  lines.push(`**Status:** ${contract.status}`);
  lines.push(`**Proposed:** ${contract.proposedAt}`);

  if (contract.reviewedBy) {
    lines.push(`**Reviewed by:** ${contract.reviewedBy}`);
    lines.push(`**Reviewed at:** ${contract.reviewedAt}`);
  }

  lines.push("");
  lines.push("## Acceptance Criteria");
  lines.push("");

  for (let i = 0; i < contract.acceptanceCriteria.length; i++) {
    const c = contract.acceptanceCriteria[i];
    const checkbox = contract.status === "completed" ? "[x]" : "[ ]";
    lines.push(`${i + 1}. ${checkbox} ${c.description}`);
    if (c.verifyCommand) {
      lines.push(`   - Verify: \`${c.verifyCommand}\``);
    }
  }

  lines.push("");
  lines.push("## File Scope");
  for (const f of contract.fileScope) {
    lines.push(`- \`${f}\``);
  }

  lines.push("");
  lines.push("## Verify Commands");
  for (const cmd of contract.verifyCommands) {
    lines.push(`- \`${cmd}\``);
  }

  if (contract.reviewNotes) {
    lines.push("");
    lines.push("## Review Notes");
    lines.push(contract.reviewNotes);
  }

  return lines.join("\n");
}

/**
 * Render contract section for agent overlay injection.
 */
export function renderContractForOverlay(contract: SprintContract): string {
  const lines: string[] = [];

  lines.push("## Sprint Contract");
  lines.push("");
  lines.push(
    "This contract was pre-approved. You MUST meet ALL acceptance criteria before reporting done.",
  );
  lines.push("");

  for (let i = 0; i < contract.acceptanceCriteria.length; i++) {
    const c = contract.acceptanceCriteria[i];
    lines.push(`${i + 1}. ${c.description}`);
    if (c.verifyCommand) {
      lines.push(`   - Verify: \`${c.verifyCommand}\``);
    }
  }

  return lines.join("\n");
}
