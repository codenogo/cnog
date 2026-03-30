import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CnogDB } from "./db.js";
import type { ArtifactRow, ArtifactType } from "./types.js";
import { runArtifactDir } from "./paths.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function relativeRunArtifactPath(feature: string, runId: string, filename: string): string {
  return join(".cnog", "features", feature, "runs", runId, filename);
}

export function persistJsonArtifact(opts: {
  db: CnogDB;
  artifactId: string;
  runId: string;
  feature: string;
  type: ArtifactType;
  filename: string;
  data: unknown;
  projectRoot?: string;
  issueId?: string | null;
  sessionId?: string | null;
  reviewScopeId?: string | null;
  markdown?: string;
}): ArtifactRow {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const dir = runArtifactDir(opts.feature, opts.runId, projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const jsonContent = JSON.stringify(opts.data, null, 2);
  const fullPath = join(dir, opts.filename);
  const fullDir = dirname(fullPath);
  if (!existsSync(fullDir)) {
    mkdirSync(fullDir, { recursive: true });
  }
  writeFileSync(fullPath, jsonContent, "utf-8");

  if (opts.markdown) {
    const mdFilename = opts.filename.endsWith(".json")
      ? opts.filename.replace(/\.json$/, ".md")
      : `${opts.filename}.md`;
    const mdPath = join(dir, mdFilename);
    const mdDir = dirname(mdPath);
    if (!existsSync(mdDir)) {
      mkdirSync(mdDir, { recursive: true });
    }
    writeFileSync(mdPath, opts.markdown, "utf-8");
  }

  const relativePath = relativeRunArtifactPath(opts.feature, opts.runId, opts.filename);
  opts.db.artifacts.create({
    id: opts.artifactId,
    run_id: opts.runId,
    feature: opts.feature,
    type: opts.type,
    path: relativePath,
    hash: hashContent(jsonContent),
    issue_id: opts.issueId ?? null,
    session_id: opts.sessionId ?? null,
    review_scope_id: opts.reviewScopeId ?? null,
  });

  return opts.db.artifacts.get(opts.artifactId)!;
}

export function loadArtifactJson<T>(
  artifact: ArtifactRow,
  projectRoot: string = process.cwd(),
): T | null {
  const fullPath = join(projectRoot, artifact.path);
  if (!existsSync(fullPath)) return null;

  try {
    return JSON.parse(readFileSync(fullPath, "utf-8")) as T;
  } catch {
    return null;
  }
}
