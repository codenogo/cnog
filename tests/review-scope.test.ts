import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CnogDB } from "../src/db.js";
import { Lifecycle } from "../src/lifecycle.js";
import { computeScopeHash, buildReviewScope, applyEvaluationResult } from "../src/review.js";
import { ContractManager, generateContract } from "../src/contracts.js";
import { EventEmitter } from "../src/events.js";

let db: CnogDB;
let tmpDir: string;
const RUN_ID = "run-scope-test";
const FEATURE = "scope-feature";

function setup() {
  tmpDir = mkdtempSync(join(tmpdir(), "cnog-scope-"));
  db = new CnogDB(join(tmpDir, "test.db"));
  db.runs.create({
    id: RUN_ID, feature: FEATURE, plan_number: null, status: "evaluate",
    phase_reason: null, profile: null, tasks: null, review: null, ship: null, worktree_path: null,
  });
}

function createSession(name: string) {
  db.sessions.create({
    id: `sid-${name}`, name, logical_name: name, attempt: 1, runtime: "claude",
    capability: "builder", feature: FEATURE, task_id: null, worktree_path: null,
    branch: `cnog/${FEATURE}/${name}`, tmux_session: null, pid: null, state: "completed",
    parent_agent: null, run_id: RUN_ID,
  });
  return `sid-${name}`;
}

function createAcceptedContract(issueId: string) {
  const events = new EventEmitter(db);
  const manager = new ContractManager(db, events, tmpDir);
  const contract = generateContract({
    task: {
      name: "scope task",
      files: ["src/scope.ts"],
      action: "Implement scoped behavior",
      verify: ["npm test"],
    },
    feature: FEATURE,
    agentName: "builder-1",
    runId: RUN_ID,
  });
  contract.taskId = issueId;
  manager.propose(contract);
  manager.accept(contract.id, FEATURE, "evaluator-1");
}

beforeEach(setup);

describe("computeScopeHash", () => {
  it("is deterministic for the same inputs", () => {
    const hash1 = computeScopeHash({
      mergeEntryIds: [3, 1, 2],
      branches: ["b", "a"],
      headShas: ["sha2", "sha1"],
      contractIds: ["c2", "c1"],
      contractHashes: ["h2", "h1"],
      verifyCommands: ["npm test", "tsc"],
    });
    const hash2 = computeScopeHash({
      mergeEntryIds: [1, 2, 3],
      branches: ["a", "b"],
      headShas: ["sha1", "sha2"],
      contractIds: ["c1", "c2"],
      contractHashes: ["h1", "h2"],
      verifyCommands: ["tsc", "npm test"],
    });
    expect(hash1).toBe(hash2);
  });

  it("changes when inputs differ", () => {
    const hash1 = computeScopeHash({
      mergeEntryIds: [1], branches: ["a"], headShas: ["sha1"],
      contractIds: ["c1"], contractHashes: ["h1"], verifyCommands: ["npm test"],
    });
    const hash2 = computeScopeHash({
      mergeEntryIds: [1], branches: ["a"], headShas: ["sha-CHANGED"],
      contractIds: ["c1"], contractHashes: ["h1"], verifyCommands: ["npm test"],
    });
    expect(hash1).not.toBe(hash2);
  });
});

describe("ReviewScopeStore", () => {
  it("creates and retrieves a scope", () => {
    db.reviewScopes.create({
      id: "scope-1", run_id: RUN_ID, scope_status: "pending", scope_hash: "abc",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: null, evaluator_session: null,
    });

    const scope = db.reviewScopes.get("scope-1");
    expect(scope).toBeDefined();
    expect(scope!.scope_status).toBe("pending");
    expect(scope!.scope_hash).toBe("abc");
  });

  it("sets verdict and updates scope_status", () => {
    db.reviewScopes.create({
      id: "scope-v", run_id: RUN_ID, scope_status: "evaluating", scope_hash: "def",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: null, evaluator_session: null,
    });

    const evalSid = "sid-eval-verdict";
    db.sessions.create({
      id: evalSid, name: "evaluator-verdict", logical_name: "evaluator-verdict", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: FEATURE, task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: RUN_ID,
    });

    db.reviewScopes.setVerdict("scope-v", "APPROVE", evalSid);
    const scope = db.reviewScopes.get("scope-v");
    expect(scope!.verdict).toBe("APPROVE");
    expect(scope!.scope_status).toBe("approved");
    expect(scope!.evaluator_session).toBe(evalSid);
    expect(scope!.evaluated_at).toBeTruthy();
  });

  it("latestApproved returns only approved scopes", () => {
    // Create real evaluator sessions for FK
    db.sessions.create({
      id: "sid-e1", name: "evaluator-e1", logical_name: "evaluator-e1", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: FEATURE, task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: RUN_ID,
    });
    db.sessions.create({
      id: "sid-e2", name: "evaluator-e2", logical_name: "evaluator-e2", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: FEATURE, task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: RUN_ID,
    });

    // First mark existing active scopes as stale for the partial unique index
    db.reviewScopes.create({
      id: "scope-rej", run_id: RUN_ID, scope_status: "rejected", scope_hash: "h1",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: "BLOCK", evaluator_session: "sid-e1",
    });

    expect(db.reviewScopes.latestApproved(RUN_ID)).toBeUndefined();

    db.reviewScopes.create({
      id: "scope-app", run_id: RUN_ID, scope_status: "approved", scope_hash: "h2",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: "APPROVE", evaluator_session: "sid-e2",
    });
    // Manually set evaluated_at for ordering
    db.reviewScopes.setVerdict("scope-app", "APPROVE", "sid-e2");

    const approved = db.reviewScopes.latestApproved(RUN_ID);
    expect(approved).toBeDefined();
    expect(approved!.id).toBe("scope-app");
  });

  it("enforces partial unique index — only one active scope per run", () => {
    db.reviewScopes.create({
      id: "scope-p1", run_id: RUN_ID, scope_status: "pending", scope_hash: "h1",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: null, evaluator_session: null,
    });

    // Second pending scope for same run should fail
    expect(() => db.reviewScopes.create({
      id: "scope-p2", run_id: RUN_ID, scope_status: "pending", scope_hash: "h2",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: null, evaluator_session: null,
    })).toThrow();
  });

  it("getByHash finds scope by run + hash", () => {
    db.sessions.create({
      id: "sid-e-hash", name: "evaluator-hash", logical_name: "evaluator-hash", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: FEATURE, task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: RUN_ID,
    });
    db.reviewScopes.create({
      id: "scope-h", run_id: RUN_ID, scope_status: "approved", scope_hash: "target-hash",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: "APPROVE", evaluator_session: "sid-e-hash",
    });

    const found = db.reviewScopes.getByHash(RUN_ID, "target-hash");
    expect(found).toBeDefined();
    expect(found!.id).toBe("scope-h");

    const notFound = db.reviewScopes.getByHash(RUN_ID, "wrong-hash");
    expect(notFound).toBeUndefined();
  });
});

describe("buildReviewScope", () => {
  it("builds a scope from pending merge entries and contract artifacts", () => {
    const sessionId = createSession("builder-1");
    const issueId = "cn-scope-1";

    // Create the issue so FK on artifacts.issue_id is satisfied
    db.issues.create({
      id: issueId, title: "scope task", description: null, issue_type: "task",
      status: "open", priority: 1, assignee: null, feature: FEATURE, run_id: RUN_ID,
      plan_number: null, phase: null, parent_id: null, metadata: null,
    });

    // Create a merge entry
    db.merges.enqueue({
      feature: FEATURE, branch: "cnog/scope-feature/builder-1", agent_name: "builder-1",
      run_id: RUN_ID, session_id: sessionId, task_id: issueId, head_sha: "abc123",
      files_modified: null,
    });

    createAcceptedContract(issueId);

    const scopeId = buildReviewScope({
      runId: RUN_ID,
      feature: FEATURE,
      db,
      projectRoot: tmpDir,
      verifyCommands: ["npm test"],
    });

    const scope = db.reviewScopes.get(scopeId);
    expect(scope).toBeDefined();
    expect(scope!.scope_status).toBe("pending");
    expect(JSON.parse(scope!.branches)).toContain("cnog/scope-feature/builder-1");
    expect(JSON.parse(scope!.head_shas)).toContain("abc123");
    expect(JSON.parse(scope!.contract_ids)[0]).toContain("art-contract-");
    expect(JSON.parse(scope!.contract_hashes)).toHaveLength(1);
    expect(JSON.parse(scope!.verify_commands)).toContain("npm test");
    expect(scope!.scope_hash).toBeTruthy();
    expect(scope!.scope_hash.length).toBe(16);

    const scopeArtifacts = db.artifacts.listByRun(RUN_ID, "review-scope");
    expect(scopeArtifacts).toHaveLength(1);
    expect(scopeArtifacts[0].review_scope_id).toBe(scopeId);
  });
});

describe("ReviewAttemptStore", () => {
  it("records an evaluation attempt", () => {
    db.reviewScopes.create({
      id: "scope-att", run_id: RUN_ID, scope_status: "evaluating", scope_hash: "h",
      merge_entries: "[]", branches: "[]", head_shas: "[]",
      contract_ids: "[]", contract_hashes: "[]", verify_commands: "[]",
      verdict: null, evaluator_session: null,
    });

    db.sessions.create({
      id: "sid-eval-att", name: "evaluator-att", logical_name: "evaluator-att", attempt: 1,
      runtime: "claude", capability: "evaluator", feature: FEATURE, task_id: null,
      worktree_path: null, branch: null, tmux_session: null, pid: null,
      state: "working", parent_agent: null, run_id: RUN_ID,
    });

    db.reviewAttempts.create({
      scope_id: "scope-att",
      evaluator_session: "sid-eval-att",
      verdict: "REQUEST_CHANGES",
      report_artifact_id: null,
      grading_artifact_id: null,
      completed_at: new Date().toISOString(),
    });

    const attempts = db.reviewAttempts.listByScope("scope-att");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].verdict).toBe("REQUEST_CHANGES");
    expect(attempts[0].completed_at).toBeTruthy();
  });

  it("persists review-report and grading-report artifacts when applying evaluation results", () => {
    const events = new EventEmitter(db);
    const lifecycle = new Lifecycle(db, events, tmpDir);

    db.reviewScopes.create({
      id: "scope-eval",
      run_id: RUN_ID,
      scope_status: "evaluating",
      scope_hash: "scope-hash",
      merge_entries: "[]",
      branches: "[]",
      head_shas: "[]",
      contract_ids: "[]",
      contract_hashes: "[]",
      verify_commands: JSON.stringify(["npm test"]),
      verdict: null,
      evaluator_session: null,
    });
    db.sessions.create({
      id: "eval-session",
      name: "evaluator-1",
      logical_name: "evaluator-1",
      attempt: 1,
      runtime: "claude",
      capability: "evaluator",
      feature: FEATURE,
      task_id: null,
      worktree_path: null,
      branch: "main",
      tmux_session: null,
      pid: null,
      state: "working",
      parent_agent: null,
      run_id: RUN_ID,
    });

    const verdict = applyEvaluationResult({
      runId: RUN_ID,
      sessionId: "eval-session",
      sessionName: "evaluator-1",
      feature: FEATURE,
      message: {
        subject: "review: APPROVE",
        payload: {
          scores: [
            { criterion: "functionality", score: 1, feedback: "ok" },
            { criterion: "completeness", score: 1, feedback: "ok" },
            { criterion: "code_quality", score: 1, feedback: "ok" },
            { criterion: "test_coverage", score: 1, feedback: "ok" },
          ],
        },
      },
      db,
      events,
      lifecycle,
      projectRoot: tmpDir,
    });

    expect(verdict).toBe("APPROVE");
    const attempts = db.reviewAttempts.listByScope("scope-eval");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].report_artifact_id).toBeTruthy();
    expect(attempts[0].grading_artifact_id).toBeTruthy();

    const reviewArtifacts = db.artifacts.listByRun(RUN_ID, "review-report");
    const gradingArtifacts = db.artifacts.listByRun(RUN_ID, "grading-report");
    expect(reviewArtifacts).toHaveLength(1);
    expect(gradingArtifacts).toHaveLength(1);
    expect(reviewArtifacts[0].review_scope_id).toBe("scope-eval");
    expect(gradingArtifacts[0].review_scope_id).toBe("scope-eval");
  });
});
