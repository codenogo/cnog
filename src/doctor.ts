import { existsSync } from "node:fs";
import { join } from "node:path";

import type { CnogConfig } from "./config.js";
import type { CnogDB } from "./db.js";
import type { Watchdog } from "./watchdog.js";
import type { RunRow } from "./types.js";
import { hasRuntime, getRuntime } from "./runtimes/index.js";
import { CNOG_DIR, DB_PATH } from "./paths.js";
import * as tmux from "./tmux.js";

export interface DoctorCheck {
  category: string;
  name: string;
  ok: boolean;
  detail: string;
}

export function buildDoctorChecks(opts: {
  projectRoot: string;
  initialized: boolean;
  config?: CnogConfig;
  db?: CnogDB;
  watchdog?: Watchdog;
}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const cnogDir = join(opts.projectRoot, CNOG_DIR);
  const dbPath = join(opts.projectRoot, DB_PATH);

  checks.push({
    category: "environment",
    name: "tmux",
    ok: tmux.isAvailable(),
    detail: tmux.isAvailable() ? "installed" : "not found",
  });

  checks.push({
    category: "project",
    name: "cnog dir",
    ok: existsSync(cnogDir),
    detail: existsSync(cnogDir) ? cnogDir : "missing (run cnog init)",
  });

  checks.push({
    category: "project",
    name: "database",
    ok: existsSync(dbPath),
    detail: existsSync(dbPath) ? dbPath : "missing",
  });

  if (!opts.initialized || !opts.config || !opts.db || !opts.watchdog) {
    return checks;
  }

  const runtimeId = opts.config.agents.runtime;
  const runtimeOk = hasRuntime(runtimeId);
  checks.push({
    category: "runtime",
    name: "configured runtime",
    ok: runtimeOk,
    detail: runtimeOk
      ? `${runtimeId} (${getRuntime(runtimeId).instructionFile})`
      : `unknown runtime '${runtimeId}'`,
  });

  const active = opts.db.sessions.active();
  checks.push({
    category: "state",
    name: "active sessions",
    ok: true,
    detail: `${active.length} active`,
  });

  const health = opts.watchdog.inspectActive().filter((entry) => entry.decision.kind !== "healthy");
  checks.push({
    category: "health",
    name: "session health",
    ok: health.length === 0,
    detail: health.length === 0
      ? "all active sessions healthy"
      : health.map((entry) => `${entry.observation.session.name}:${entry.decision.kind}`).join(", "),
  });

  const conflicts = opts.db.merges.list().filter((entry) => entry.status === "conflict");
  checks.push({
    category: "merge",
    name: "merge conflicts",
    ok: conflicts.length === 0,
    detail: conflicts.length === 0
      ? "none"
      : conflicts.map((entry) => `${entry.feature}:${entry.branch}`).join(", "),
  });

  const unread = opts.db.messages.checkMail("orchestrator").length;
  checks.push({
    category: "mail",
    name: "orchestrator inbox",
    ok: unread === 0,
    detail: unread === 0 ? "empty" : `${unread} unread message(s)`,
  });

  // Integrity: active sessions must have valid run_id
  const sessionsWithoutRun = active.filter((s) => {
    if (!s.run_id) return true;
    return !opts.db!.runs.get(s.run_id);
  });
  checks.push({
    category: "integrity",
    name: "session run references",
    ok: sessionsWithoutRun.length === 0,
    detail: sessionsWithoutRun.length === 0
      ? "all sessions reference valid runs"
      : `${sessionsWithoutRun.length} session(s) with missing run: ${sessionsWithoutRun.map((s) => s.name).join(", ")}`,
  });

  // Integrity: no runs stuck in build/evaluate with zero active sessions
  const activeRuns = opts.db.db.prepare(
    "SELECT * FROM runs WHERE status NOT IN ('done','failed')",
  ).all() as RunRow[];
  const stuckRuns = activeRuns.filter((run) => {
    if (run.status !== "build" && run.status !== "evaluate") return false;
    const runSessions = opts.db!.sessions.list({ run_id: run.id });
    return runSessions.every((s) => s.state === "completed" || s.state === "failed");
  });
  checks.push({
    category: "integrity",
    name: "stuck runs",
    ok: stuckRuns.length === 0,
    detail: stuckRuns.length === 0
      ? "no stuck runs"
      : `${stuckRuns.length} run(s) stuck: ${stuckRuns.map((r) => `${r.id}(${r.status})`).join(", ")}`,
  });

  // Integrity: registered artifacts should have files on disk
  const allArtifacts = opts.db.db.prepare("SELECT * FROM artifacts").all() as Array<{ id: string; path: string }>;
  const missingFiles = allArtifacts.filter((a) => !existsSync(join(opts.projectRoot, a.path)));
  checks.push({
    category: "integrity",
    name: "artifact files",
    ok: missingFiles.length === 0,
    detail: missingFiles.length === 0
      ? `${allArtifacts.length} artifact(s), all present`
      : `${missingFiles.length} artifact(s) missing files: ${missingFiles.map((a) => a.id).join(", ")}`,
  });

  return checks;
}
