# cnog

Multi-agent orchestrator for Claude Code. Coordinates multiple AI coding agents working in parallel on a codebase through tmux sessions, SQLite state, git worktrees, and structured messaging.

## What It Does

cnog breaks a feature into tasks, negotiates contracts for each task, spawns builder agents in isolated git worktrees, evaluates their output against structured grading rubrics, and merges approved work into the canonical branch. The entire lifecycle is run-authoritative — every session, issue, artifact, and merge entry belongs to a specific run.

```
plan → contract → build → evaluate → merge → ship → done
              ↑                ↓         ↓
              └── rework ──────┘─────────┘
```

## Prerequisites

- Node.js >= 20
- tmux
- git
- Claude Code CLI (`claude`)

## Install

```bash
git clone git@github.com:codenogo/cnog.git
cd cnog
npm install
npm run build
npm link   # optional: makes `cnog` available globally
```

## Quick Start

```bash
# Initialize in your project
cd /path/to/your-project
cnog init

# Create a feature skeleton with a blank plan
cnog shape add-auth

# Edit the plan at docs/planning/work/features/add-auth/01-PLAN.json
# Then dispatch — proposes contracts and spawns builders
cnog sling add-auth

# Spawn evaluator to review completed work
cnog evaluate add-auth

# Check fleet status
cnog status
cnog dashboard        # live TUI

# Ship when evaluation passes and merges complete
cnog ship add-auth
```

## Architecture

### Runs Are Authoritative

A **run** is the single execution unit. A feature is just a namespace. Every session, issue, contract, artifact, merge entry, and review scope belongs to exactly one run, enforced by foreign keys.

Canonical phases:

| Phase | What Happens |
|-------|-------------|
| `plan` | Planner produces a structured plan artifact and issue DAG |
| `contract` | For each ready issue, cnog proposes a sprint contract. Evaluator must accept before builders start |
| `build` | Builders implement code in isolated worktrees against accepted contracts |
| `evaluate` | Evaluator scores implementation against grading rubric on an exact review scope |
| `merge` | Only approved review scopes can merge. 4-tier conflict resolution |
| `ship` | Canonical verification, then PR creation |
| `done` | Terminal success |
| `failed` | Terminal failure (can restart via `failed → plan`) |

Rework is normal:
- `evaluate → build` — implementation failed, scope still valid
- `evaluate → contract` — contract was wrong or incomplete
- `merge → build` — conflicts reveal invalid assumptions

### Four Planes

1. **State** — SQLite (13 tables, WAL mode, foreign keys enforced). All truth lives here. The orchestrator can crash and restart without losing state.
2. **Execution** — tmux sessions on a dedicated socket (`cnog`). Humans can attach to any agent session with `tmux -L cnog attach -t <session>`.
3. **Isolation** — git worktrees. Each agent gets its own branch (`cnog/<feature>/<agent>`) and working directory under `.cnog/worktrees/`.
4. **Coordination** — typed mail system in SQLite. Message types: status, result, error, worker_done, merge_ready, escalation.

### Three Agent Roles

| Role | Can Write Code | Purpose |
|------|---------------|---------|
| **planner** | No | Expand prompts into structured task plans |
| **builder** | Yes | Implement code within contracted file scope |
| **evaluator** | No | Gate contracts pre-build; score implementations post-build |

Everything else — orchestrator, merge processor, watchdog — is a system service, not an agent persona.

### Artifact-First Model

Every important object gets an immutable JSON artifact registered in the `artifacts` table with a content hash. Artifacts are stored under `.cnog/features/<feature>/runs/<runId>/`.

Artifact types: `plan`, `contract`, `checkpoint`, `review-scope`, `review-report`, `grading-report`, `verify-report`, `merge-record`, `ship-report`.

New version = new row. Artifacts are never mutated.

### Evaluator As Gate

The evaluator gates the pipeline twice:

**Pre-build (contract phase):** Reviews proposed sprint contracts. Checks acceptance criteria are testable, file scope is bounded, verify commands are valid. Returns ACCEPT or REJECT per contract.

**Post-build (evaluate phase):** Reviews implementation against a deterministic review scope. Scores each criterion (functionality, completeness, code quality, test coverage) on a 0.0-1.0 scale with hard thresholds. Returns APPROVE, REQUEST_CHANGES, or BLOCK.

The review scope captures immutable state: merge entry IDs, branch head SHAs, contract hashes, verify commands. The evaluator's verdict is attached to the scope hash. `merge.ts` refuses to merge if the pending state drifts from the approved scope.

## CLI Reference

### Core

| Command | Description |
|---------|-------------|
| `cnog init` | Initialize cnog in the current project |
| `cnog doctor` | Health and integrity checks |
| `cnog status [--json]` | Fleet overview |
| `cnog dashboard` | Live terminal dashboard |
| `cnog start` | Start the orchestrator daemon |
| `cnog stop` | Stop the orchestrator daemon |

### Feature Workflow

| Command | Description |
|---------|-------------|
| `cnog shape <feature>` | Create feature skeleton with blank plan |
| `cnog plan <feature> [--validate] [--json]` | Show or validate a plan |
| `cnog sling <feature> [--profile NAME]` | Propose contracts and spawn builders |
| `cnog evaluate <feature>` | Spawn evaluator (contract review or implementation review) |
| `cnog merge [--feature NAME] [--all] [--dry-run]` | Process merge queue |
| `cnog ship <feature>` | Verify and ship a feature |

### Runs

| Command | Description |
|---------|-------------|
| `cnog run list [feature]` | List runs |
| `cnog run show <run-id> [--json]` | Show run details, artifacts, scopes |
| `cnog run reset <run-id> [--reason TEXT]` | Archive and reset a stuck run |

### Agents

| Command | Description |
|---------|-------------|
| `cnog agents [--state STATE] [--json]` | List agents |
| `cnog spawn <capability> <name> --task TEXT --feature NAME` | Spawn agent manually |
| `cnog stop-agent <name> [--force] [--clean]` | Stop an agent |
| `cnog inspect <name> [--json]` | Inspect agent state + tmux output |
| `cnog nudge <name> [--text TEXT]` | Send a nudge to an agent |
| `cnog heartbeat <name>` | Record heartbeat |

### Contracts

| Command | Description |
|---------|-------------|
| `cnog contract show <id> --feature NAME` | Show contract details |
| `cnog contract accept <id> --feature NAME` | Accept a contract |
| `cnog contract reject <id> --feature NAME --notes TEXT` | Reject a contract |

### Mail

| Command | Description |
|---------|-------------|
| `cnog mail send <to> <subject> [--from NAME] [--type TYPE]` | Send a message |
| `cnog mail check [--agent NAME]` | Check unread mail |
| `cnog mail list [--agent NAME] [--limit N]` | List messages |

### Work Tracking

| Command | Description |
|---------|-------------|
| `cnog memory create <title> [--feature NAME]` | Create an issue |
| `cnog memory list [--feature NAME] [--status STATUS]` | List issues |
| `cnog memory ready [--feature NAME]` | Show ready (unblocked) issues |
| `cnog memory claim <id> <assignee>` | Claim an issue |
| `cnog memory close <id>` | Close an issue |
| `cnog memory stats [--feature NAME]` | Issue statistics |

### Observability

| Command | Description |
|---------|-------------|
| `cnog feed [--agent NAME] [--follow]` | Live event stream |
| `cnog logs [--agent NAME] [--level LEVEL] [--limit N]` | Query event log |
| `cnog costs [--json]` | Token usage and cost summary |
| `cnog grade [--rubric NAME]` | Show grading rubric |
| `cnog checkpoint save --agent NAME --summary TEXT` | Save checkpoint |
| `cnog checkpoint show <agent>` | Show checkpoint |
| `cnog checkpoint progress <agent>` | Show progress artifact |
| `cnog checkpoint handoffs <agent>` | Handoff history |

### Lifecycle

| Command | Description |
|---------|-------------|
| `cnog phase get <feature>` | Get current run phase |
| `cnog phase advance <feature> <target>` | Advance run phase |
| `cnog phase list` | List all features with phases |

## Configuration

cnog reads `.cnog/config.yaml` with optional `.cnog/config.local.yaml` for machine-specific overrides.

```yaml
project:
  name: my-project
  root: .
  canonicalBranch: main

agents:
  runtime: claude
  maxConcurrent: 4
  bootDelayMs: 2000

orchestrator:
  tickIntervalMs: 10000
  maxWip: 4

watchdog:
  staleThresholdMs: 300000    # 5 minutes
  zombieThresholdMs: 900000   # 15 minutes

verify:
  commands: []
```

### Delivery Profiles

Profiles configure execution strategy per feature:

| Profile | Concurrency | Review | Ship |
|---------|------------|--------|------|
| `feature-delivery` | 4 parallel | Auto-evaluate | PR required, auto-ship |
| `local-dev` | 2 parallel | Manual | No PR required |
| `migration-rollout` | 1 serial | Auto-evaluate | PR required, manual ship |
| `quick-fix` | 1 serial | Manual | PR required, auto-ship |

```bash
cnog sling add-auth --profile feature-delivery
```

## Database Schema

13 tables with enforced foreign keys:

| Table | Purpose |
|-------|---------|
| `runs` | Canonical execution units with phase lifecycle |
| `sessions` | Agent tmux sessions (FK → runs) |
| `messages` | Inter-agent typed mail |
| `merge_queue` | FIFO merge entries with head SHA (FK → runs, sessions) |
| `issues` | Work-breakdown tasks (FK → runs) |
| `issue_deps` | Task dependency DAG |
| `issue_events` | Issue audit trail |
| `artifacts` | Immutable artifact registry with content hash (FK → runs, issues, sessions, review_scopes) |
| `review_scopes` | Exact evaluation candidate snapshots (FK → runs, sessions) |
| `review_attempts` | Evaluator passes on scopes (FK → review_scopes, sessions, artifacts) |
| `metrics` | Token usage and cost tracking |
| `events` | Structured event log |
| `feature_phases` | Derived projection (not authority) |

Key constraints:
- One active (non-terminal) run per feature (partial unique index)
- One active (pending/evaluating) review scope per run (partial unique index)
- Foreign keys on all cross-table references

## Development

```bash
npm run build        # Compile TypeScript
npm run dev          # Run with tsx (no build needed)
npm test             # Run all tests
npm run test:watch   # Watch mode
npm run typecheck    # Type check without emitting
```

### Testing

32 test files, 296 tests. Tests use in-memory SQLite via tmpdir. External dependencies (tmux, git) are mocked with `vi.mock`.

Tests must create runs before sessions, issues, or merge entries — foreign keys are enforced in tests too.

```bash
npx vitest run                    # all tests
npx vitest run tests/lifecycle    # specific file
npx vitest run -t "canMerge"     # specific test name
```

## How It Works End-to-End

1. **`cnog shape add-auth`** — Creates a run in `plan` phase, writes a blank plan template.

2. **Human edits the plan** — Fills in tasks, file scopes, verify commands, dependencies.

3. **`cnog sling add-auth`** — Registers the plan as an artifact, advances to `contract` phase, proposes sprint contracts for each ready task.

4. **`cnog evaluate add-auth`** — Spawns evaluator to review contracts. Evaluator returns ACCEPT/REJECT per contract. Accepted contracts advance the run to `build`.

5. **Builders spawn automatically** — Each builder gets an isolated worktree, an overlay with its contract, file scope guards via Claude Code hooks, and verify commands.

6. **Builders report done** — Via `cnog mail send orchestrator "done" --type worker_done`. Orchestrator enqueues merge entries with head SHAs.

7. **`cnog evaluate add-auth`** — When all builders finish, spawns evaluator for implementation review. Builds a deterministic review scope from pending merge entries, head SHAs, and contract hashes. Evaluator scores against grading rubric.

8. **APPROVE advances to merge** — `merge.ts` processes the queue with 4-tier conflict resolution (clean, auto, AI, reimagine). Scope-hash gating prevents merging stale approvals.

9. **`cnog ship add-auth`** — Runs canonical verification against the approved scope, creates verify-report and ship-report artifacts, outputs the `gh pr create` command.

## License

MIT
