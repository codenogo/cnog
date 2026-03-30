import type { CnogDB } from "./db.js";
import type { MemoryEngine } from "./memory.js";
import { ContractManager } from "./contracts.js";

export type RunNextAction =
  | { kind: "propose_contracts"; reason: string }
  | { kind: "spawn_contract_evaluator"; reason: string }
  | { kind: "spawn_builders"; reason: string }
  | { kind: "spawn_implementation_evaluator"; reason: string }
  | { kind: "idle"; reason: string }
  | { kind: "blocked"; reason: string };

function hasActiveSessions(db: CnogDB, runId: string, capability?: string): boolean {
  return db.sessions
    .list({ run_id: runId })
    .some((session) => (
      (!capability || session.capability === capability)
      && session.state !== "completed"
      && session.state !== "failed"
    ));
}

export function decideNextRunAction(opts: {
  runId: string;
  db: CnogDB;
  memory: MemoryEngine;
  projectRoot?: string;
}): RunNextAction {
  const run = opts.db.runs.get(opts.runId);
  if (!run) {
    return { kind: "blocked", reason: `Run ${opts.runId} not found` };
  }

  const contracts = new ContractManager(opts.db, { emit() {} } as never, opts.projectRoot);
  const readyIssues = opts.memory.readyForRun(run.id);
  const runnableContracts = readyIssues.map((issue) => ({
    issue,
    contract: contracts.loadLatestForIssue(issue.id, run.feature),
  }));

  if (run.status === "plan") {
    return { kind: "propose_contracts", reason: "Plan exists but contracts have not been proposed yet" };
  }

  if (run.status === "contract") {
    if (hasActiveSessions(opts.db, run.id, "evaluator")) {
      return { kind: "idle", reason: "Contract evaluator already in progress" };
    }

    if (runnableContracts.some(({ contract }) => !contract || contract.status === "rejected" || contract.status === "failed")) {
      return { kind: "propose_contracts", reason: "Ready issues are missing an accepted contract" };
    }

    if (runnableContracts.some(({ contract }) => contract?.status === "pending_review")) {
      return { kind: "spawn_contract_evaluator", reason: "Pending contracts need evaluator approval" };
    }

    if (runnableContracts.some(({ contract }) => contract?.status === "accepted" || contract?.status === "completed")) {
      return { kind: "spawn_builders", reason: "Accepted contracts are ready for builder execution" };
    }

    return { kind: "blocked", reason: "No ready issues are available for contract progression" };
  }

  if (run.status === "build") {
    if (hasActiveSessions(opts.db, run.id)) {
      return { kind: "idle", reason: "Build work is already in flight" };
    }

    if (runnableContracts.some(({ contract }) => contract?.status === "accepted" || contract?.status === "completed")) {
      return { kind: "spawn_builders", reason: "Ready issues have accepted contracts and can be built" };
    }

    const remainingIssues = opts.db.issues
      .list({ run_id: run.id })
      .filter((issue) => issue.status === "open" || issue.status === "in_progress");
    if (remainingIssues.length === 0) {
      if (opts.db.merges.pendingForRun(run.id).length > 0) {
        return { kind: "spawn_implementation_evaluator", reason: "All build work is complete; evaluation is next" };
      }
      return { kind: "idle", reason: "Build work is complete and no pending merge scope remains" };
    }

    return { kind: "blocked", reason: "Run has unresolved issues but no ready accepted work" };
  }

  if (run.status === "evaluate") {
    if (hasActiveSessions(opts.db, run.id, "evaluator")) {
      return { kind: "idle", reason: "Implementation evaluator already in progress" };
    }

    if (opts.db.merges.pendingForRun(run.id).length > 0) {
      return { kind: "spawn_implementation_evaluator", reason: "Pending merge scope needs evaluator review" };
    }

    return { kind: "blocked", reason: "Evaluate phase has no pending merge scope to review" };
  }

  return { kind: "idle", reason: `No automated action for ${run.status} phase` };
}
