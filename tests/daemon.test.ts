import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { CnogDB } from "../src/db.js";
import { CNOG_DIR, DB_PATH } from "../src/paths.js";
import { removePidFile } from "../src/config.js";

const captured = vi.hoisted(() => ({
  lifecycleRoots: [] as string[],
  mergeRoots: [] as string[],
  agentRoots: [] as string[],
  dispatcherRoots: [] as string[],
  executionRoots: [] as string[],
  orchestratorRoots: [] as string[],
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    createWriteStream: vi.fn(() => ({
      write: vi.fn(),
      end: (cb?: () => void) => cb?.(),
    })),
  };
});

vi.mock("../src/lifecycle.js", () => ({
  Lifecycle: vi.fn().mockImplementation((_db, _events, projectRoot: string) => {
    captured.lifecycleRoots.push(projectRoot);
    return {};
  }),
}));

vi.mock("../src/merge.js", () => ({
  MergeQueue: vi.fn().mockImplementation((_db, _events, _branch, projectRoot: string) => {
    captured.mergeRoots.push(projectRoot);
    return {};
  }),
}));

vi.mock("../src/agents.js", () => ({
  AgentManager: vi.fn().mockImplementation((_db, _events, projectRoot: string) => {
    captured.agentRoots.push(projectRoot);
    return {};
  }),
}));

vi.mock("../src/dispatch.js", () => ({
  Dispatcher: vi.fn().mockImplementation((_db, _lifecycle, _memory, _events, projectRoot: string) => {
    captured.dispatcherRoots.push(projectRoot);
    return {};
  }),
}));

vi.mock("../src/execution.js", () => ({
  ExecutionEngine: vi.fn().mockImplementation(
    (
      _db,
      _agents,
      _lifecycle,
      _memory,
      _mergeQueue,
      _events,
      _dispatcher,
      _runtimeId,
      _canonicalBranch,
      projectRoot: string,
    ) => {
      captured.executionRoots.push(projectRoot);
      return {};
    },
  ),
}));

vi.mock("../src/orchestrator.js", () => ({
  Orchestrator: vi.fn().mockImplementation(
    (_db, _events, _mail, _mergeQueue, _watchdog, _lifecycle, config: { projectRoot: string }) => {
      captured.orchestratorRoots.push(config.projectRoot);
      return {
        start: vi.fn(),
        stop: vi.fn(),
      };
    },
  ),
}));

import { runDaemon } from "../src/daemon.js";

describe.sequential("daemon project root resolution", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cnog-daemon-test-"));
    mkdirSync(join(tmpDir, CNOG_DIR), { recursive: true });
    mkdirSync(join(tmpDir, "packages", "app"), { recursive: true });
    writeFileSync(
      join(tmpDir, CNOG_DIR, "config.yaml"),
      "project:\n  root: packages/app\n",
      "utf-8",
    );

    const db = new CnogDB(join(tmpDir, DB_PATH));
    db.close();

    captured.lifecycleRoots.length = 0;
    captured.mergeRoots.length = 0;
    captured.agentRoots.length = 0;
    captured.dispatcherRoots.length = 0;
    captured.executionRoots.length = 0;
    captured.orchestratorRoots.length = 0;
  });

  afterEach(() => {
    removePidFile(tmpDir);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wires lifecycle and execution services against config.project.root", async () => {
    const expectedRoot = resolve(tmpDir, "packages/app");

    await runDaemon(tmpDir);

    expect(captured.lifecycleRoots).toEqual([expectedRoot]);
    expect(captured.mergeRoots).toEqual([expectedRoot]);
    expect(captured.agentRoots).toEqual([expectedRoot]);
    expect(captured.dispatcherRoots).toEqual([expectedRoot]);
    expect(captured.executionRoots).toEqual([expectedRoot]);
    expect(captured.orchestratorRoots).toEqual([expectedRoot]);
  });
});
