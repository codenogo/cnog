import type { CnogDB } from "./db.js";
import type { CnogConfig } from "./config.js";
import type { MergeQueueRow, SessionRow, RunRow } from "./types.js";
import type { Watchdog } from "./watchdog.js";
import type { SessionHealth } from "./watchdog-policy.js";
import { listRuntimes } from "./runtimes/index.js";

export interface AgentStatus {
  name: string;
  runtime: string;
  capability: string;
  state: string;
  feature: string | null;
  branch: string | null;
  runId: string;
  lastHeartbeat: string | null;
  health: SessionHealth["decision"]["kind"];
  healthReason: string | null;
}

export interface RunStatus {
  id: string;
  feature: string;
  phase: string;
  phaseReason: string | null;
  profile: string | null;
  artifactCount: number;
  activeScopeStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureStatus {
  feature: string;
  phase: string;
  reviewVerdict: string | null;
  profile: string | null;
}

export interface StatusSnapshot {
  summary: {
    configuredRuntime: string;
    availableRuntimes: string[];
    activeAgents: number;
    activeRuns: number;
    pendingMerges: number;
    mergeConflicts: number;
    unreadMail: number;
    trackedFeatures: number;
  };
  agents: AgentStatus[];
  runs: RunStatus[];
  merges: MergeQueueRow[];
  features: FeatureStatus[];
  health: SessionHealth[];
}

function toAgentStatus(session: SessionRow, health: SessionHealth | undefined): AgentStatus {
  return {
    name: session.name,
    runtime: session.runtime,
    capability: session.capability,
    state: session.state,
    feature: session.feature,
    branch: session.branch,
    runId: session.run_id,
    lastHeartbeat: session.last_heartbeat,
    health: health?.decision.kind ?? "healthy",
    healthReason: health?.decision.reason ?? null,
  };
}

function toRunStatus(run: RunRow, db: CnogDB): RunStatus {
  const artifacts = db.artifacts.listByRun(run.id);
  const activeScope = db.reviewScopes.activeForRun(run.id);
  return {
    id: run.id,
    feature: run.feature,
    phase: run.status,
    phaseReason: run.phase_reason,
    profile: run.profile,
    artifactCount: artifacts.length,
    activeScopeStatus: activeScope?.scope_status ?? null,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function buildFeatureStatuses(db: CnogDB): FeatureStatus[] {
  const runs = db.db.prepare(
    "SELECT * FROM runs ORDER BY created_at DESC, rowid DESC",
  ).all() as RunRow[];
  const latestByFeature = new Map<string, RunRow>();

  for (const run of runs) {
    if (!latestByFeature.has(run.feature)) {
      latestByFeature.set(run.feature, run);
    }
  }

  return [...latestByFeature.values()]
    .sort((a, b) => a.feature.localeCompare(b.feature))
    .map((run) => {
      const latestScope = db.reviewScopes.activeForRun(run.id)
        ?? db.reviewScopes.listByRun(run.id)[0];
      return {
        feature: run.feature,
        phase: run.status,
        reviewVerdict: latestScope?.verdict ?? null,
        profile: run.profile,
      };
    });
}

export function buildStatusSnapshot(
  db: CnogDB,
  config: CnogConfig,
  watchdog: Watchdog,
): StatusSnapshot {
  const health = watchdog.inspectActive();
  const healthByAgent = new Map(health.map((entry) => [entry.observation.session.name, entry]));
  const activeAgents = db.sessions.active();
  const merges = db.merges.list();
  const features = buildFeatureStatuses(db);

  // Get active runs (non-terminal)
  const activeRuns = db.db.prepare(
    "SELECT * FROM runs WHERE status NOT IN ('done','failed') ORDER BY created_at DESC",
  ).all() as RunRow[];

  const unreadMail = db.messages.checkMail("orchestrator");

  return {
    summary: {
      configuredRuntime: config.agents.runtime,
      availableRuntimes: listRuntimes(),
      activeAgents: activeAgents.length,
      activeRuns: activeRuns.length,
      pendingMerges: merges.filter((entry) => entry.status === "pending").length,
      mergeConflicts: merges.filter((entry) => entry.status === "conflict").length,
      unreadMail: unreadMail.length,
      trackedFeatures: features.length,
    },
    agents: activeAgents.map((session) => toAgentStatus(session, healthByAgent.get(session.name))),
    runs: activeRuns.map((run) => toRunStatus(run, db)),
    merges,
    features,
    health,
  };
}
