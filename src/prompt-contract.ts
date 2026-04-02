import type {
  Capability,
  EscalationCode,
  GradingRubric,
  WorkerExecutionKind,
} from "./types.js";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ArtifactReference {
  id?: string;
  path: string;
  hash?: string;
  issueId?: string;
  title?: string;
}

export interface ProtocolAuthority {
  canWrite: boolean;
  canMerge: boolean;
  canPush: boolean;
  canChangeScope: boolean;
  canonicalVerificationOwner: "orchestrator";
}

export interface WorkerProtocolContract {
  protocolVersion: 1;
  role: Capability;
  executionKind: WorkerExecutionKind;
  agentName: string;
  feature: string;
  runId: string;
  executionTaskId?: string;
  issueId?: string;
  reviewScopeId?: string;
  scopeHash?: string;
  branch?: string;
  authority: ProtocolAuthority;
  fileScope: string[];
  dependencyBranches: string[];
  localSanityChecks: string[];
  notificationType: "worker_notification";
  resultPayloadKind: string;
  resultRequiredFields: string[];
  completionCommand: string;
  escalationCommand: string;
  escalationCodes: EscalationCode[];
  checkpointCommand: string;
}

export interface BuilderAssignmentSpec {
  kind: "builder_assignment";
  objective: string;
  planTaskKey: string;
  taskIndex: number;
  taskName: string;
  action: string;
  planGoal?: string;
  fileScope: string[];
  microSteps: string[];
  contextLinks: string[];
  canonicalVerifyCommands: string[];
  packageVerifyCommands: string[];
}

export interface ContractReviewAssignmentSpec {
  kind: "contract_review_assignment";
  objective: string;
  runId: string;
  feature: string;
  planGoal?: string;
  contracts: Array<ArtifactReference>;
}

export interface ImplementationReviewAssignmentSpec {
  kind: "implementation_review_assignment";
  objective: string;
  runId: string;
  feature: string;
  scopeId: string;
  scopeHash: string;
  branches: string[];
  contractArtifacts: Array<ArtifactReference>;
  verifyArtifacts: Array<ArtifactReference>;
  rubric: GradingRubric;
}

export interface PlannerAssignmentSpec {
  kind: "planner_assignment";
  objective: string;
  feature: string;
  runId: string;
  outputPath: string;
  guidance: string[];
}

export interface GenericAssignmentSpec {
  kind: "generic_assignment";
  objective: string;
  details: string;
}

export type WorkerAssignmentSpec =
  | BuilderAssignmentSpec
  | ContractReviewAssignmentSpec
  | ImplementationReviewAssignmentSpec
  | PlannerAssignmentSpec
  | GenericAssignmentSpec;

export function createBuilderAssignmentSpec(opts: {
  objective: string;
  planTaskKey: string;
  taskIndex: number;
  taskName: string;
  action: string;
  planGoal?: string;
  fileScope: string[];
  microSteps?: string[];
  contextLinks?: string[];
  canonicalVerifyCommands?: string[];
  packageVerifyCommands?: string[];
}): BuilderAssignmentSpec {
  return {
    kind: "builder_assignment",
    objective: opts.objective,
    planTaskKey: opts.planTaskKey,
    taskIndex: opts.taskIndex,
    taskName: opts.taskName,
    action: opts.action,
    planGoal: opts.planGoal,
    fileScope: [...opts.fileScope],
    microSteps: opts.microSteps ? [...opts.microSteps] : [],
    contextLinks: opts.contextLinks ? [...opts.contextLinks] : [],
    canonicalVerifyCommands: opts.canonicalVerifyCommands ? [...opts.canonicalVerifyCommands] : [],
    packageVerifyCommands: opts.packageVerifyCommands ? [...opts.packageVerifyCommands] : [],
  };
}

export function createContractReviewAssignmentSpec(opts: {
  objective: string;
  runId: string;
  feature: string;
  planGoal?: string;
  contracts: Array<ArtifactReference>;
}): ContractReviewAssignmentSpec {
  return {
    kind: "contract_review_assignment",
    objective: opts.objective,
    runId: opts.runId,
    feature: opts.feature,
    planGoal: opts.planGoal,
    contracts: opts.contracts.map((contract) => ({ ...contract })),
  };
}

export function createImplementationReviewAssignmentSpec(opts: {
  objective: string;
  runId: string;
  feature: string;
  scopeId: string;
  scopeHash: string;
  branches: string[];
  contractArtifacts: Array<ArtifactReference>;
  verifyArtifacts: Array<ArtifactReference>;
  rubric: GradingRubric;
}): ImplementationReviewAssignmentSpec {
  return {
    kind: "implementation_review_assignment",
    objective: opts.objective,
    runId: opts.runId,
    feature: opts.feature,
    scopeId: opts.scopeId,
    scopeHash: opts.scopeHash,
    branches: [...opts.branches],
    contractArtifacts: opts.contractArtifacts.map((artifact) => ({ ...artifact })),
    verifyArtifacts: opts.verifyArtifacts.map((artifact) => ({ ...artifact })),
    rubric: opts.rubric,
  };
}

export function createPlannerAssignmentSpec(opts: {
  objective: string;
  feature: string;
  runId: string;
  outputPath: string;
  guidance?: string[];
}): PlannerAssignmentSpec {
  return {
    kind: "planner_assignment",
    objective: opts.objective,
    feature: opts.feature,
    runId: opts.runId,
    outputPath: opts.outputPath,
    guidance: opts.guidance ? [...opts.guidance] : [],
  };
}

export function buildBuilderCompletionCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  executionTaskId?: string;
  issueId?: string;
  branch?: string;
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  return `cnog report builder-complete${agent} --summary ${shellQuote("<summary>")} --head-sha ${shellQuote("<head_sha>")} --files ${shellQuote("<file-path>,<file-path>")}`;
}

export function buildGenericCompletionCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  role: Capability;
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  return `cnog report generic-complete${agent} --role ${opts.role} --summary ${shellQuote("<summary>")}`;
}

export function buildContractReviewResultCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  contractIds: string[];
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  const decisions = JSON.stringify(opts.contractIds.map((contractId) => ({
    contractId,
    decision: "ACCEPT",
    notes: "<notes>",
  })));
  return `cnog report contract-review${agent} --summary ${shellQuote("<summary>")} --decisions ${shellQuote(decisions)}`;
}

export function buildImplementationReviewResultCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  scopeId: string;
  scopeHash: string;
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  const scores = JSON.stringify([{ criterion: "functionality", score: 0, feedback: "<feedback>" }]);
  return `cnog report implementation-review${agent} --summary ${shellQuote("<summary>")} --scope-id ${opts.scopeId} --scope-hash ${opts.scopeHash} --verdict APPROVE --rework-phase build --scores ${shellQuote(scores)}`;
}

export function buildPlannerCompletionCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  planPath: string;
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  return `cnog report planner-complete${agent} --summary ${shellQuote("<summary>")} --plan-path ${shellQuote(opts.planPath)} --task-count 0 --plan-hash ${shellQuote("<plan_hash>")}`;
}

export function buildEscalationCommand(opts: {
  agentName?: string;
  runId?: string;
  feature?: string;
  role: Capability;
}): string {
  const agent = opts.agentName ? ` --agent ${opts.agentName}` : "";
  return `cnog report blocked${agent} --role ${opts.role} --code ${shellQuote("<code>")} --summary ${shellQuote("<summary>")} --evidence ${shellQuote("[\"<evidence>\"]")} --requested-action ${shellQuote("<requested_action>")}`;
}

export function buildWorkerProtocolContract(opts: {
  role: Capability;
  executionKind: WorkerExecutionKind;
  agentName: string;
  feature: string;
  runId: string;
  executionTaskId?: string;
  issueId?: string;
  reviewScopeId?: string;
  scopeHash?: string;
  branch?: string;
  fileScope?: string[];
  dependencyBranches?: string[];
  localSanityChecks?: string[];
  completionCommand: string;
  resultPayloadKind: string;
  resultRequiredFields: string[];
  escalationCodes: EscalationCode[];
}): WorkerProtocolContract {
  return {
    protocolVersion: 1,
    role: opts.role,
    executionKind: opts.executionKind,
    agentName: opts.agentName,
    feature: opts.feature,
    runId: opts.runId,
    executionTaskId: opts.executionTaskId,
    issueId: opts.issueId,
    reviewScopeId: opts.reviewScopeId,
    scopeHash: opts.scopeHash,
    branch: opts.branch,
    authority: {
      canWrite: opts.role === "builder",
      canMerge: false,
      canPush: false,
      canChangeScope: false,
      canonicalVerificationOwner: "orchestrator",
    },
    fileScope: opts.fileScope ?? [],
    dependencyBranches: opts.dependencyBranches ?? [],
    localSanityChecks: opts.localSanityChecks ?? [],
    notificationType: "worker_notification",
    resultPayloadKind: opts.resultPayloadKind,
    resultRequiredFields: opts.resultRequiredFields,
    completionCommand: opts.completionCommand,
    escalationCommand: buildEscalationCommand({
      agentName: opts.agentName,
      role: opts.role,
    }),
    escalationCodes: opts.escalationCodes,
    checkpointCommand: `cnog checkpoint save --agent ${opts.agentName} --summary "<what you finished>" --pending "<what remains>"`,
  };
}

function renderList(values: string[], empty: string): string {
  if (values.length === 0) return `- ${empty}`;
  return values.map((value) => `- ${value}`).join("\n");
}

function renderArtifactList(items: Array<ArtifactReference>, empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => {
    const parts = [item.path];
    if (item.hash) parts.push(item.hash);
    if (item.title) parts.push(item.title);
    return `- ${parts.join(" | ")}`;
  }).join("\n");
}

export function renderProtocolContractMarkdown(contract: WorkerProtocolContract): string {
  const lines: string[] = [];
  lines.push("## Protocol Contract");
  lines.push("");
  lines.push("### Runtime Envelope");
  lines.push(`- Protocol Version: ${contract.protocolVersion}`);
  lines.push(`- Role: ${contract.role}`);
  lines.push(`- Execution Kind: ${contract.executionKind}`);
  lines.push(`- Run: ${contract.runId}`);
  if (contract.executionTaskId) lines.push(`- Execution Task: ${contract.executionTaskId}`);
  if (contract.issueId) lines.push(`- Issue: ${contract.issueId}`);
  if (contract.reviewScopeId) lines.push(`- Review Scope: ${contract.reviewScopeId}`);
  if (contract.scopeHash) lines.push(`- Scope Hash: ${contract.scopeHash}`);
  if (contract.branch) lines.push(`- Branch: ${contract.branch}`);
  lines.push("");
  lines.push("### Authority");
  lines.push(`- Can write code: ${contract.authority.canWrite ? "yes" : "no"}`);
  lines.push(`- Can merge branches: ${contract.authority.canMerge ? "yes" : "no"}`);
  lines.push(`- Can push remotes: ${contract.authority.canPush ? "yes" : "no"}`);
  lines.push(`- Can change scope autonomously: ${contract.authority.canChangeScope ? "yes" : "no"}`);
  lines.push(`- Canonical verification owner: ${contract.authority.canonicalVerificationOwner}`);
  lines.push("");
  lines.push("### Concurrency Contract");
  lines.push(renderList(contract.fileScope, "No file scope declared."));
  lines.push("");
  lines.push("Dependency branches:");
  lines.push(renderList(contract.dependencyBranches, "No dependency branches."));
  lines.push("");
  lines.push("### Verification Contract");
  lines.push("- Canonical verification is performed by cnog verify tasks and artifacts.");
  lines.push("- Local sanity checks are optional support work, not the authoritative pass/fail signal.");
  lines.push(renderList(contract.localSanityChecks, "No local sanity checks declared."));
  lines.push("");
  lines.push("### Result Contract");
  lines.push(`- Notification type: ${contract.notificationType}`);
  lines.push(`- Data kind: ${contract.resultPayloadKind}`);
  lines.push(`- Required semantic fields: ${contract.resultRequiredFields.join(", ")}`);
  lines.push(`- Completion command: \`${contract.completionCommand}\``);
  lines.push("");
  lines.push("### Escalation Contract");
  lines.push(`- Allowed codes: ${contract.escalationCodes.join(", ")}`);
  lines.push(`- Escalation command: \`${contract.escalationCommand}\``);
  lines.push("");
  lines.push("### Checkpoint Contract");
  lines.push(`- Save a checkpoint before yielding blocked work or when context needs handoff.`);
  lines.push(`- Command: \`${contract.checkpointCommand}\``);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(contract, null, 2));
  lines.push("```");
  return lines.join("\n");
}

export function renderAssignmentSpecMarkdown(spec: WorkerAssignmentSpec): string {
  const lines: string[] = [];
  lines.push("## Assignment Spec");
  lines.push("");

  switch (spec.kind) {
    case "builder_assignment":
      lines.push(`Objective: ${spec.objective}`);
      if (spec.planGoal) lines.push(`Plan goal: ${spec.planGoal}`);
      lines.push(`Plan task: ${spec.planTaskKey} (#${spec.taskIndex + 1})`);
      lines.push(`Task name: ${spec.taskName}`);
      lines.push("");
      lines.push("Action:");
      lines.push(spec.action);
      lines.push("");
      lines.push("Micro steps:");
      lines.push(renderList(spec.microSteps, "No micro steps declared."));
      lines.push("");
      lines.push("Context links:");
      lines.push(renderList(spec.contextLinks, "No context links declared."));
      lines.push("");
      lines.push("Canonical verify commands:");
      lines.push(renderList(spec.canonicalVerifyCommands, "No canonical verify commands declared."));
      if (spec.packageVerifyCommands.length > 0) {
        lines.push("");
        lines.push("Package-level sanity checks:");
        lines.push(renderList(spec.packageVerifyCommands, "None."));
      }
      break;
    case "contract_review_assignment":
      lines.push(`Objective: ${spec.objective}`);
      if (spec.planGoal) lines.push(`Plan goal: ${spec.planGoal}`);
      lines.push("");
      lines.push("Pending contracts:");
      lines.push(renderArtifactList(spec.contracts, "No pending contracts."));
      break;
    case "implementation_review_assignment":
      lines.push(`Objective: ${spec.objective}`);
      lines.push(`Scope: ${spec.scopeId}`);
      lines.push(`Scope hash: ${spec.scopeHash}`);
      lines.push("");
      lines.push("Candidate branches:");
      lines.push(renderList(spec.branches, "No branches declared."));
      lines.push("");
      lines.push("Accepted contract artifacts:");
      lines.push(renderArtifactList(spec.contractArtifacts, "No accepted contracts."));
      lines.push("");
      lines.push("Verification artifacts:");
      lines.push(renderArtifactList(spec.verifyArtifacts, "No review-scope verify artifacts."));
      lines.push("");
      lines.push("Grading rubric:");
      lines.push("```json");
      lines.push(JSON.stringify(spec.rubric, null, 2));
      lines.push("```");
      break;
    case "planner_assignment":
      lines.push(`Objective: ${spec.objective}`);
      lines.push(`Output path: ${spec.outputPath}`);
      lines.push("");
      lines.push("Guidance:");
      lines.push(renderList(spec.guidance, "No additional guidance."));
      break;
    case "generic_assignment":
      lines.push(`Objective: ${spec.objective}`);
      lines.push("");
      lines.push(spec.details);
      break;
  }

  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(spec, null, 2));
  lines.push("```");
  return lines.join("\n");
}

function instructionReference(instructionFile?: string): string {
  return instructionFile
    ? `Read ${instructionFile}`
    : "Read the runtime instruction file in the current worktree";
}

export function buildLaunchPrompt(spec: WorkerAssignmentSpec, instructionFile?: string): string {
  const readInstruction = instructionReference(instructionFile);
  switch (spec.kind) {
    case "builder_assignment":
      return [
        `${readInstruction} and execute builder assignment ${spec.planTaskKey}.`,
        `Objective: ${spec.objective}`,
        "Stay inside the declared file scope, treat cnog verify artifacts as canonical, and use the Result Contract or Escalation Contract exactly.",
      ].join("\n");
    case "contract_review_assignment":
      return [
        `${readInstruction} and perform the contract review assignment.`,
        `Objective: ${spec.objective}`,
        "Return only structured contract decisions using the Result Contract.",
      ].join("\n");
    case "implementation_review_assignment":
      return [
        `${readInstruction} and evaluate scope ${spec.scopeId}.`,
        `Objective: ${spec.objective}`,
        "Grade only the declared scope hash and return a structured implementation review payload.",
      ].join("\n");
    case "planner_assignment":
      return [
        `${readInstruction} and produce the requested plan artifact.`,
        `Objective: ${spec.objective}`,
        "Generate a concurrency-safe plan with explicit file scopes and realistic verification.",
      ].join("\n");
    case "generic_assignment":
      return [
        `${readInstruction} and complete the generic assignment.`,
        `Objective: ${spec.objective}`,
        "Use the explicit Result Contract or Escalation Contract when you finish or get blocked.",
      ].join("\n");
  }
}
