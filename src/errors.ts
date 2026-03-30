/**
 * Error catalog with actionable fix suggestions.
 *
 * Each error code maps to a user-facing fix template.
 * Placeholders like {feature} are filled by callers.
 */

export const ERROR_CATALOG: Record<string, { message: string; fix: string }> = {
  // Orchestrator
  TMUX_NOT_INSTALLED: {
    message: "tmux is not installed",
    fix: "Install tmux: brew install tmux",
  },
  GIT_NOT_AVAILABLE: {
    message: "git is not installed or not on PATH",
    fix: "Install git: brew install git",
  },
  NOT_INITIALIZED: {
    message: "cnog not initialized in this project",
    fix: "Run: cnog init",
  },
  DB_LOCKED: {
    message: "Database is locked by another process",
    fix: "Check for other cnog processes: ps aux | grep cnog",
  },

  // Agent lifecycle
  AGENT_ALREADY_EXISTS: {
    message: "Agent {name} already exists with state {state}",
    fix: "Stop it first: cnog stop-agent {name}",
  },
  AGENT_NOT_FOUND: {
    message: "Agent {name} not found",
    fix: "List agents: cnog agents",
  },
  INVALID_CAPABILITY: {
    message: "Invalid capability: {capability}",
    fix: "Valid capabilities: planner, builder, evaluator",
  },

  // Feature lifecycle
  FEATURE_NOT_FOUND: {
    message: "Feature {feature} not found",
    fix: "Create it: cnog shape {feature}",
  },
  PLAN_NOT_FOUND: {
    message: "No plan found for feature {feature}",
    fix: "Generate one: cnog plan {feature}",
  },
  CONTEXT_MISSING: {
    message: "CONTEXT.json missing for feature {feature}",
    fix: "Run discuss phase first to generate context",
  },

  // Merge
  RUN_NOT_FOUND: {
    message: "Run {runId} not found",
    fix: "List runs: cnog run list {feature}",
  },
  CONTRACT_NOT_ACCEPTED: {
    message: "Contract {contractId} has not been accepted",
    fix: "Accept the contract: cnog contract accept {contractId} --feature {feature}",
  },
  SCOPE_MISMATCH: {
    message: "Review scope hash does not match pending merge entries",
    fix: "Rebuild the review scope or re-evaluate",
  },
  MERGE_SCOPE_INVALID: {
    message: "Merge blocked: no approved review scope for run {runId}",
    fix: "Run evaluation first: cnog evaluate {feature}",
  },
  MERGE_CONFLICT: {
    message: "Merge conflict on branch {branch}",
    fix: "Resolve manually and re-enqueue",
  },

  // Ship
  SHIP_NO_REMOTE: {
    message: "No git remote configured",
    fix: "Add a remote: git remote add origin <url>",
  },
  GH_NOT_INSTALLED: {
    message: "GitHub CLI (gh) not installed",
    fix: "Install: brew install gh && gh auth login",
  },
  SHIP_NOT_READY: {
    message: "Feature {feature} not ready to ship",
    fix: "Complete evaluation first: cnog evaluate {feature}",
  },

  // Planning
  PLAN_VALIDATION_FAILED: {
    message: "Plan validation failed for {feature}",
    fix: "Check plan: cat docs/planning/work/features/{feature}/*-PLAN.json",
  },
  PLAN_SCHEMA_ERROR: {
    message: "Plan has invalid schema",
    fix: "Required fields: schemaVersion, feature, planNumber, goal, tasks[], planVerify[], commitMessage",
  },
};

export function _format(
  template: string,
  kwargs: Record<string, string>,
): string {
  if (!template) return "";
  try {
    return template.replace(/\{(\w+)\}/g, (match, key: string) =>
      key in kwargs ? kwargs[key] : match,
    );
  } catch {
    return template;
  }
}

/**
 * Structured error with a fix suggestion.
 */
export class CnogError extends Error {
  readonly code: string;
  readonly kwargs: Record<string, string>;
  readonly fix: string;

  constructor(code: string, kwargs: Record<string, string> = {}) {
    const entry = ERROR_CATALOG[code] ?? { message: code, fix: "" };
    const message = _format(entry.message, kwargs);
    const fix = _format(entry.fix, kwargs);

    super(message);
    this.name = "CnogError";
    this.code = code;
    this.kwargs = kwargs;
    this.fix = fix;
  }

  override toString(): string {
    if (this.fix) {
      return `${this.message}\n  Fix: ${this.fix}`;
    }
    return this.message;
  }
}

/**
 * Get fix suggestion for an error code.
 */
export function errorFix(
  code: string,
  kwargs: Record<string, string> = {},
): string {
  const entry = ERROR_CATALOG[code];
  if (!entry) return "";
  return _format(entry.fix, kwargs);
}
