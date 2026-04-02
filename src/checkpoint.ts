/**
 * Session checkpoint and handoff system.
 *
 * Checkpoints are run-scoped artifacts keyed by logical agent identity, so
 * retries can recover prior context without depending on concrete session
 * names. The latest artifact state determines whether a checkpoint is active,
 * pending handoff, completed, or cleared.
 */

import type { CnogDB } from "./db.js";
import type {
  ArtifactRow,
  SessionCheckpoint,
  SessionHandoff,
  HandoffReason,
  SessionCheckpointResumeContext,
} from "./types.js";
import { persistJsonArtifact, loadArtifactJson } from "./artifacts.js";
import { findProjectRoot } from "./paths.js";

export interface CheckpointSelector {
  runId: string;
  feature: string;
  logicalName: string;
}

type CheckpointState = "active" | "pending" | "completed" | "cleared";

interface StoredCheckpointArtifact {
  kind: "checkpoint";
  state: CheckpointState;
  checkpoint: SessionCheckpoint;
  handoff: SessionHandoff | null;
}

function checkpointDirectory(logicalName: string): string {
  return `checkpoints/${logicalName}`;
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[:.]/g, "-");
}

function checkpointFilename(
  logicalName: string,
  sessionId: string,
  timestamp: string,
): string {
  return `${checkpointDirectory(logicalName)}/checkpoint-${sessionId}-${safeTimestamp(timestamp)}.json`;
}

function checkpointArtifactId(
  logicalName: string,
  sessionId: string,
  timestamp: string,
): string {
  return `art-checkpoint-${logicalName}-${sessionId}-${safeTimestamp(timestamp)}`;
}

function renderProgressMarkdown(checkpoint: SessionCheckpoint): string {
  const lines: string[] = [];
  const resume = checkpoint.resumeContext;

  lines.push(`# Progress: ${checkpoint.logicalName}`);
  lines.push("");
  lines.push(`**Feature:** ${checkpoint.feature}`);
  lines.push(`**Run:** ${checkpoint.runId}`);
  lines.push(`**Agent:** ${checkpoint.agentName}`);
  lines.push(`**Task:** ${checkpoint.taskId}`);
  lines.push(`**Session:** ${checkpoint.sessionId}`);
  lines.push(`**Timestamp:** ${checkpoint.timestamp}`);
  lines.push(`**Branch:** ${checkpoint.currentBranch}`);
  lines.push("");

  lines.push("## What was accomplished");
  lines.push(checkpoint.progressSummary);
  lines.push("");

  if (checkpoint.filesModified.length > 0) {
    lines.push("## Files modified");
    for (const file of checkpoint.filesModified) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  if (Object.keys(checkpoint.verifyResults).length > 0) {
    lines.push("## Verify results");
    for (const [command, passed] of Object.entries(checkpoint.verifyResults)) {
      lines.push(`- \`${command}\`: ${passed ? "PASS" : "FAIL"}`);
    }
    lines.push("");
  }

  if (checkpoint.pendingWork) {
    lines.push("## Pending work (pick up here)");
    lines.push(checkpoint.pendingWork);
    lines.push("");
  }

  lines.push("## Resume context");
  lines.push(`- Transcript: ${resume.transcriptPath ?? "-"}`);
  lines.push(`- Task log: ${resume.taskLogPath ?? "-"}`);
  lines.push(`- Last activity: ${resume.lastActivitySummary ?? "-"}`);
  lines.push(`- Last activity at: ${resume.lastActivityAt ?? "-"}`);
  lines.push(`- Tool uses: ${resume.toolUseCount}`);
  lines.push(`- Duration: ${resume.durationMs ?? 0}ms`);
  lines.push(`- Tokens: in=${resume.inputTokens} out=${resume.outputTokens}`);
  lines.push(`- Cost: $${resume.costUsd.toFixed(4)}`);
  if (resume.scratchpad.shared || resume.scratchpad.role || resume.scratchpad.agent) {
    lines.push("");
    lines.push("## Scratchpad");
    if (resume.scratchpad.shared) lines.push(`- Shared: \`${resume.scratchpad.shared}\``);
    if (resume.scratchpad.role) lines.push(`- Role: \`${resume.scratchpad.role}\``);
    if (resume.scratchpad.agent) lines.push(`- Agent: \`${resume.scratchpad.agent}\``);
  }
  if (resume.recentActivities.length > 0) {
    lines.push("");
    lines.push("## Recent activities");
    for (const activity of resume.recentActivities.slice(-5)) {
      lines.push(`- ${activity.at} [${activity.kind}] ${activity.summary}`);
    }
  }
  if (resume.transcriptTail) {
    lines.push("");
    lines.push("## Transcript tail");
    lines.push("```text");
    lines.push(resume.transcriptTail);
    lines.push("```");
  }
  if (resume.taskLogTail) {
    lines.push("");
    lines.push("## Task log tail");
    lines.push("```text");
    lines.push(resume.taskLogTail);
    lines.push("```");
  }

  return lines.join("\n");
}

function isCheckpointPayload(value: unknown): value is StoredCheckpointArtifact {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredCheckpointArtifact>;
  return candidate.kind === "checkpoint"
    && !!candidate.checkpoint
    && typeof candidate.state === "string"
    && !!candidate.checkpoint.resumeContext;
}

function listCheckpointArtifacts(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string,
): Array<{ artifact: ArtifactRow; payload: StoredCheckpointArtifact }> {
  return db.artifacts
    .listByRun(selector.runId, "checkpoint")
    .map((artifact) => ({
      artifact,
      payload: loadArtifactJson<StoredCheckpointArtifact>(
        artifact,
        projectRoot,
      ) as StoredCheckpointArtifact | null,
    }))
    .filter((entry): entry is { artifact: ArtifactRow; payload: StoredCheckpointArtifact } => (
      isCheckpointPayload(entry.payload)
      && entry.payload.checkpoint.runId === selector.runId
      && entry.payload.checkpoint.feature === selector.feature
      && entry.payload.checkpoint.logicalName === selector.logicalName
    ));
}

function latestCheckpointState(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string,
): { artifact: ArtifactRow; payload: StoredCheckpointArtifact } | null {
  const artifacts = listCheckpointArtifacts(db, selector, projectRoot);
  return artifacts.length > 0 ? artifacts[artifacts.length - 1] : null;
}

function persistCheckpointState(opts: {
  db: CnogDB;
  checkpoint: SessionCheckpoint;
  state: CheckpointState;
  projectRoot?: string;
  handoff?: SessionHandoff | null;
}): ArtifactRow {
  return persistJsonArtifact({
    db: opts.db,
    artifactId: checkpointArtifactId(
      opts.checkpoint.logicalName,
      opts.checkpoint.sessionId,
      opts.checkpoint.timestamp,
    ),
    runId: opts.checkpoint.runId,
    feature: opts.checkpoint.feature,
    type: "checkpoint",
    filename: checkpointFilename(
      opts.checkpoint.logicalName,
      opts.checkpoint.sessionId,
      opts.checkpoint.timestamp,
    ),
    data: {
      kind: "checkpoint",
      state: opts.state,
      checkpoint: opts.checkpoint,
      handoff: opts.handoff ?? null,
    } satisfies StoredCheckpointArtifact,
    projectRoot: opts.projectRoot,
    issueId: opts.checkpoint.taskId || null,
    sessionId: opts.checkpoint.sessionId,
    markdown: renderProgressMarkdown(opts.checkpoint),
  });
}

/**
 * Save the latest active checkpoint state for a logical agent.
 */
export function saveCheckpoint(
  checkpoint: SessionCheckpoint,
  db: CnogDB,
  projectRoot: string = findProjectRoot(),
): void {
  persistCheckpointState({
    db,
    checkpoint,
    state: "active",
    projectRoot,
  });
}

/**
 * Load the current active or pending checkpoint for a logical agent.
 */
export function loadCheckpoint(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string = findProjectRoot(),
): SessionCheckpoint | null {
  const latest = latestCheckpointState(db, selector, projectRoot);
  if (!latest) return null;
  return latest.payload.state === "active" || latest.payload.state === "pending"
    ? latest.payload.checkpoint
    : null;
}

/**
 * Mark the latest checkpoint as cleared. Artifact history remains immutable.
 */
export function clearCheckpoint(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string = findProjectRoot(),
): void {
  const latest = latestCheckpointState(db, selector, projectRoot);
  if (!latest) return;
  persistCheckpointState({
    db,
    checkpoint: {
      ...latest.payload.checkpoint,
      timestamp: new Date().toISOString(),
    },
    state: "cleared",
    projectRoot,
    handoff: latest.payload.handoff,
  });
}

/**
 * Initiate a handoff: persist a pending checkpoint artifact.
 */
export function initiateHandoff(
  checkpoint: SessionCheckpoint,
  reason: HandoffReason,
  db: CnogDB,
  projectRoot: string = findProjectRoot(),
): SessionHandoff {
  const handoff: SessionHandoff = {
    fromSessionId: checkpoint.sessionId,
    toSessionId: null,
    checkpoint,
    reason,
    handoffAt: new Date().toISOString(),
  };

  persistCheckpointState({
    db,
    checkpoint,
    state: "pending",
    projectRoot,
    handoff,
  });

  return handoff;
}

/**
 * Return the latest unresolved handoff for a logical agent, if any.
 */
export function resumeFromHandoff(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string = findProjectRoot(),
): SessionHandoff | null {
  const handoffs = loadHandoffs(db, selector, projectRoot);
  for (let i = handoffs.length - 1; i >= 0; i--) {
    if (handoffs[i].toSessionId === null) {
      return handoffs[i];
    }
  }
  return null;
}

/**
 * Complete a pending handoff by writing a terminal checkpoint artifact.
 */
export function completeHandoff(
  db: CnogDB,
  selector: CheckpointSelector,
  fromSessionId: string,
  toSessionId: string,
  projectRoot: string = findProjectRoot(),
): void {
  const pending = resumeFromHandoff(db, selector, projectRoot);
  if (!pending || pending.fromSessionId !== fromSessionId) {
    return;
  }

  const completed: SessionHandoff = {
    ...pending,
    toSessionId,
  };

  persistCheckpointState({
    db,
    checkpoint: {
      ...pending.checkpoint,
      timestamp: new Date().toISOString(),
    },
    state: "completed",
    projectRoot,
    handoff: completed,
  });
}

/**
 * Load all known handoff attempts for a logical agent, deduped by source session.
 */
export function loadHandoffs(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string = findProjectRoot(),
): SessionHandoff[] {
  const handoffs = new Map<string, SessionHandoff>();
  for (const entry of listCheckpointArtifacts(db, selector, projectRoot)) {
    if (!entry.payload.handoff) continue;
    handoffs.set(entry.payload.handoff.fromSessionId, entry.payload.handoff);
  }
  return [...handoffs.values()].sort((a, b) => a.handoffAt.localeCompare(b.handoffAt));
}

/**
 * Render the latest active or pending progress artifact for a logical agent.
 */
export function loadProgressArtifact(
  db: CnogDB,
  selector: CheckpointSelector,
  projectRoot: string = findProjectRoot(),
): string | null {
  const checkpoint = loadCheckpoint(db, selector, projectRoot);
  return checkpoint ? renderProgressMarkdown(checkpoint) : null;
}

export function extractResumeContext(checkpoint: SessionCheckpoint): SessionCheckpointResumeContext {
  return checkpoint.resumeContext;
}
