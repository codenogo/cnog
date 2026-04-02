/**
 * tmux session management — the execution plane.
 *
 * Each agent runs in its own tmux session on a dedicated socket.
 * The human can attach to any session to observe or interact.
 */

import { spawnSync } from "node:child_process";

import { TMUX_SOCKET, SESSION_PREFIX } from "./paths.js";

export { TMUX_SOCKET };

export interface TmuxSession {
  name: string;
  pid: number | null;
  workingDir: string | null;
}

interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Check if tmux is installed and reachable.
 */
export function isAvailable(): boolean {
  try {
    const result = spawnSync("tmux", ["-V"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return result.error === undefined;
  } catch {
    return false;
  }
}

/**
 * Run a tmux command on the cnog socket.
 */
export function _tmux(...args: string[]): SpawnResult {
  const cmd = ["tmux", "-L", TMUX_SOCKET, ...args];
  const result = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    return { status: 127, stdout: "", stderr: "tmux not found" };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * List all cnog tmux sessions.
 */
export function listSessions(): TmuxSession[] {
  const result = _tmux(
    "list-sessions",
    "-F",
    "#{session_name}:#{pane_pid}:#{pane_current_path}",
  );

  if (result.status !== 0) {
    return [];
  }

  const sessions: TmuxSession[] = [];
  const lines = result.stdout.trim().split("\n");

  for (const line of lines) {
    if (!line) continue;
    const parts = line.split(":", 3);
    if (parts.length >= 1) {
      const name = parts[0];
      const pid =
        parts.length > 1 && /^\d+$/.test(parts[1])
          ? parseInt(parts[1], 10)
          : null;
      const workingDir = parts.length > 2 ? parts[2] : null;
      sessions.push({ name, pid, workingDir });
    }
  }

  return sessions;
}

/**
 * Check if a tmux session exists.
 */
export function isSessionAlive(sessionName: string): boolean {
  const result = _tmux("has-session", "-t", sessionName);
  return result.status === 0;
}

/**
 * Get the PID of the main pane process in a session.
 */
export function getPanePid(sessionName: string): number | null {
  const result = _tmux(
    "list-panes",
    "-t",
    sessionName,
    "-F",
    "#{pane_pid}",
  );

  if (result.status !== 0) {
    return null;
  }

  const lines = result.stdout.trim().split("\n");
  const pidStr = lines[0] ?? "";
  return /^\d+$/.test(pidStr) ? parseInt(pidStr, 10) : null;
}

/**
 * Create a new detached tmux session running a command.
 *
 * Returns the pane PID if successful, null otherwise.
 */
export function spawnSession(
  sessionName: string,
  workingDir: string,
  command: string = "claude --dangerously-skip-permissions",
): number | null {
  const result = _tmux(
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-c",
    workingDir,
    command,
  );

  if (result.status !== 0) {
    return null;
  }

  return getPanePid(sessionName);
}

/**
 * Send keystrokes to a tmux session (nudge an agent).
 */
export function sendKeys(
  sessionName: string,
  text: string,
  enter: boolean = true,
): boolean {
  const args = ["send-keys", "-t", sessionName, text];
  if (enter) {
    args.push("Enter");
  }
  const result = _tmux(...args);
  return result.status === 0;
}

/**
 * Terminate a tmux session.
 */
export function killSession(sessionName: string): boolean {
  const result = _tmux("kill-session", "-t", sessionName);
  return result.status === 0;
}

/**
 * Capture recent output from a tmux pane.
 */
export function capturePane(
  sessionName: string,
  lines: number = 50,
): string | null {
  const result = _tmux(
    "capture-pane",
    "-t",
    sessionName,
    "-p",
    `-S-${lines}`,
  );

  if (result.status !== 0) {
    return null;
  }

  return result.stdout;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Persist pane output to one or more files.
 */
export function pipePaneToFiles(sessionName: string, outputPaths: string[]): boolean {
  const uniquePaths = [...new Set(outputPaths.filter((path) => path.length > 0))];
  if (uniquePaths.length === 0) {
    return false;
  }

  const command = uniquePaths.length === 1
    ? `cat >> ${shellEscape(uniquePaths[0])}`
    : `tee -a ${uniquePaths.map((path) => shellEscape(path)).join(" ")} >/dev/null`;
  const result = _tmux(
    "pipe-pane",
    "-o",
    "-t",
    sessionName,
    command,
  );

  return result.status === 0;
}

/**
 * Persist pane output to a transcript file.
 */
export function pipePaneToFile(sessionName: string, transcriptPath: string): boolean {
  return pipePaneToFiles(sessionName, [transcriptPath]);
}

/**
 * Generate tmux session name from agent name.
 */
export function sessionNameFor(agentName: string): string {
  return `${SESSION_PREFIX}${agentName}`;
}
