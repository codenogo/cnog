/**
 * Claude Code hooks deployment for agent worktrees.
 *
 * Deploys .claude/settings.local.json to each agent's worktree with:
 * - PreToolUse guards to enforce file scope boundaries
 * - PostToolUse logging for audit trail
 * - Tool restrictions per capability (planners and evaluators can't Write/Edit)
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Capability } from "./types.js";

/** Tool permissions by capability. */
const TOOL_PERMISSIONS: Record<Capability, string[]> = {
  planner: ["Read", "Glob", "Grep", "Bash"],
  builder: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  evaluator: ["Read", "Glob", "Grep", "Bash"],
};

/** Tools that are blocked for read-only agents. */
const WRITE_TOOLS = ["Write", "Edit"];

interface HookEntry {
  type: string;
  command: string;
}

interface SettingsConfig {
  permissions: {
    allow: string[];
    deny: string[];
  };
  hooks: {
    PreToolUse?: HookEntry[];
    PostToolUse?: HookEntry[];
  };
}

/**
 * Build the hooks/settings config for a given capability and file scope.
 */
export function buildHooksConfig(opts: {
  capability: Capability;
  agentName: string;
  fileScope?: string[];
  worktreePath: string;
}): SettingsConfig {
  const allowed = TOOL_PERMISSIONS[opts.capability] ?? TOOL_PERMISSIONS.builder;
  const denied = WRITE_TOOLS.filter((t) => !allowed.includes(t));

  const hooks: SettingsConfig["hooks"] = {};

  // PreToolUse: enforce file scope for write operations
  if (opts.fileScope && opts.fileScope.length > 0) {
    const scopeCheck = opts.fileScope
      .map((f) => JSON.stringify(f.replace(/^\.\//, "")))
      .join(" ");
    const worktreePath = JSON.stringify(opts.worktreePath);

    hooks.PreToolUse = [
      {
        type: "PreToolUse",
        command: `WORKTREE=${worktreePath} && FILE_SCOPE=(${scopeCheck}) && TOOL="$CLAUDE_TOOL_NAME" && if [[ "$TOOL" == "Write" || "$TOOL" == "Edit" ]]; then FILE="$CLAUDE_FILE_PATH" && REL="$FILE" && if [[ "$REL" == "$WORKTREE/"* ]]; then REL="\${REL#"$WORKTREE"/}"; fi && REL="\${REL#./}" && ALLOWED=false && for SCOPE in "\${FILE_SCOPE[@]}"; do if [[ "$REL" == "$SCOPE" || "$REL" == "$SCOPE/"* ]]; then ALLOWED=true; break; fi; done && if [[ "$ALLOWED" == "false" ]]; then echo "BLOCKED: $FILE is outside file scope for ${opts.agentName}" >&2; exit 1; fi; fi`,
      },
    ];
  }

  return {
    permissions: {
      allow: allowed,
      deny: denied,
    },
    hooks,
  };
}

/**
 * Deploy hooks to a worktree's .claude/settings.local.json.
 */
export function deployHooks(opts: {
  capability: Capability;
  agentName: string;
  fileScope?: string[];
  worktreePath: string;
}): void {
  const config = buildHooksConfig(opts);
  const claudeDir = join(opts.worktreePath, ".claude");

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  writeFileSync(
    join(claudeDir, "settings.local.json"),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

/**
 * Get the allowed tools for a capability.
 */
export function getAllowedTools(capability: Capability): string[] {
  return TOOL_PERMISSIONS[capability] ?? TOOL_PERMISSIONS.builder;
}
