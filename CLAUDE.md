# CLAUDE.md — cnog

Agent instructions for the cnog orchestrator project (TypeScript port of cnogo).

## Project Overview

**cnog** is a multi-agent orchestrator for Claude Code. It's a TypeScript CLI binary that manages tmux sessions, SQLite state, git worktrees, and inter-agent messaging to coordinate multiple Claude Code agents working in parallel on a codebase.

## Quick Reference

```bash
# Install
npm install
npm run build

# Dev
tsx src/index.ts --help

# Test
npx vitest run

# Type check
npx tsc --noEmit

# Run
cnog --help
cnog init             # Initialize project
cnog doctor           # Health check
cnog sling <feat>     # Spawn agents for a feature
cnog evaluate <feat>  # Spawn evaluator agent
cnog status           # Fleet overview
cnog run list         # List all runs
cnog dashboard        # Live terminal UI
```

## Code Organisation

```
src/
├── index.ts           # CLI entry point (shebang)
├── cli.ts             # yargs router — delegates to commands/
├── paths.ts           # Centralized path constants + artifact paths
├── types.ts           # Shared zod schemas + TS types (single canonical enum per concept)
├── db.ts              # SQLite state (13 tables, WAL mode, FK enforced, domain stores)
├── errors.ts          # Error catalog + CnogError
├── config.ts          # YAML config loader + PID file management
├── events.ts          # Structured event logging
├── tmux.ts            # tmux session management
├── worktree.ts        # Git worktree isolation
├── mail.ts            # Inter-agent messaging
├── overlay.ts         # Two-layer instruction generation
├── hooks.ts           # Claude Code hooks deployment to worktrees
├── lifecycle.ts       # Run-authoritative state machine
├── agents.ts          # Agent lifecycle management
├── watchdog.ts        # Process monitoring + stall detection
├── memory.ts          # Issue-based work tracking
├── merge.ts           # FIFO merge queue + 4-tier resolution (scope-hash gated)
├── orchestrator.ts    # Main dispatch loop + restart recovery
├── dispatch.ts        # Plan-to-agent bridge
├── review.ts          # Review scope construction + scope hash computation
├── dashboard.ts       # Terminal dashboard
├── checkpoint.ts      # Session checkpoint + handoff system
├── contracts.ts       # Sprint contract negotiation + artifact registry
├── grading.ts         # Structured grading rubric + evaluation
├── status.ts          # Run-level status snapshots
├── doctor.ts          # Health + integrity checks
├── commands/          # CLI command handlers (one per domain)
│   ├── context.ts     # DI container + withDb()
│   ├── init.ts
│   ├── doctor.ts
│   ├── status.ts
│   ├── orchestrator.ts
│   ├── agents.ts
│   ├── mail.ts
│   ├── lifecycle.ts   # Phase, ship, run list/show commands
│   ├── memory.ts
│   ├── planning.ts
│   └── observability.ts
├── runtimes/          # Pluggable agent runtime adapters
│   ├── types.ts       # AgentRuntime interface
│   ├── claude.ts      # Claude Code adapter (default)
│   └── index.ts       # Runtime registry
└── planning/
    ├── index.ts
    ├── profiles.ts    # Delivery policy profiles
    └── plan-factory.ts # Plan generation + validation

agents/                # Base agent definitions (3 roles)
├── builder.md         # Code implementation agent
├── evaluator.md       # Pre-build contract + post-build implementation gate
└── planner.md         # Prompt-to-plan expansion agent

tests/                 # vitest tests (30 files, 279 tests)
```

## Architecture

### Core Principle: Runs Are Authoritative

A **run** is the single authoritative execution unit. A feature is just a namespace; a run is the real thing being planned, built, evaluated, merged, and shipped.

Canonical run phases: `plan → contract → build → evaluate → merge → ship → done → failed`

Rework is normal, not exceptional:
- `evaluate → build` when implementation failed but scope is valid
- `evaluate → contract` when the contract was wrong or incomplete
- `merge → build` when merge reveals conflicts or invalid assumptions
- `failed → plan` to restart from scratch

### Four Planes

1. **State plane** — SQLite with 13 tables, FK enforced, WAL mode. Domain stores: sessions, messages, merge_queue, runs, metrics, events, feature_phases (derived), issues, artifacts, review_scopes, review_attempts
2. **Execution plane** — tmux (dedicated socket `cnog`, one session per agent)
3. **Isolation plane** — git worktrees (one branch per agent)
4. **Coordination plane** — typed mail system (status, result, error, worker_done, merge_ready, escalation)

### Artifact-First Model

Every important object gets an immutable JSON artifact registered in the `artifacts` table with run_id, feature, type, path, hash. Artifacts are stored under `.cnog/features/<feature>/runs/<runId>/`. New version = new artifact row.

### Evaluator As Gate

The evaluator gates twice:
- **Pre-build:** contract approval — acceptance criteria, file scope, verify commands
- **Post-build:** implementation approval — structured grading against rubric

A review scope captures the exact state being evaluated: merge entry IDs, branch names, head SHAs, contract IDs + hashes, verify command set. The evaluator's verdict is attached to the scope hash. merge.ts refuses if the pending scope drifts from the approved scope.

### Key Patterns

- **Generator-Evaluator separation** — evaluator uses structured grading rubric, never evaluates own work
- **Sprint contracts** — acceptance criteria negotiated before builders start, not auto-accepted
- **Scope-hash merge gating** — merge requires approved review scope with matching hash
- **Context resets** — checkpoint + handoff system for multi-session continuity
- **Hooks enforcement** — .claude/settings.local.json deployed per worktree for file scope guards
- **Restart recovery** — orchestrator can die and restart without losing truth

## Agent Capabilities

| Capability | Can Write | Role |
|-----------|-----------|------|
| planner | No | Expand prompts into structured plans |
| builder | Yes | Implement code within file scope |
| evaluator | No | Gate contracts and score implementations |

System services (not agent roles): orchestrator, merge processor, watchdog, runtime adapter.

## Conventions

### Naming
- Files: `kebab-case.ts` for multi-word, `lowercase.ts` for single word
- Interfaces/Types: `PascalCase`
- Functions: `camelCase`
- Constants: `SCREAMING_SNAKE_CASE`

### Style
- ESM modules (`"type": "module"` in package.json)
- Strict TypeScript (`strict: true`)
- Zod for runtime validation, TypeScript for compile-time types
- Synchronous APIs where matching Python behavior (better-sqlite3, spawnSync)
- All path constants in `paths.ts` — never hardcode `.cnog` elsewhere
- Domain stores on CnogDB (db.sessions, db.messages, etc.)
- Single canonical enum per concept — no duplicates, no deprecated shims
- run_id required everywhere — no defaults, FK enforced
- feature_phases is a derived projection — never read as authority

### Git
- Branch naming: `cnog/<feature>/<agent-name>`
- Commit format: `feat(scope): description` or `fix(scope): description`

## Testing

- Framework: vitest
- All tests must pass before committing
- Mock external dependencies (tmux, git) via vi.mock
- Use `tmpdir` for database tests
- Tests must create runs before sessions/issues/merges (FK enforced)
- Schema consistency tests verify SQL columns match TypeScript types

## Key Design Decisions

1. **SQLite via better-sqlite3** — synchronous API matches Python's sqlite3
2. **tmux, not subprocess** — human can attach to any agent session
3. **yargs, not commander** — rich subcommand support with type inference
4. **zod for validation** — runtime + compile-time type safety
5. **Synchronous core** — spawnSync for shell commands matches Python behavior
6. **ESM throughout** — modern Node.js module system
7. **Domain stores** — CnogDB exposes typed store interfaces per domain
8. **Command extraction** — one handler file per domain in src/commands/
9. **Runtime abstraction** — pluggable AgentRuntime interface for multi-runtime support
10. **Hooks enforcement** — file scope guards deployed to each worktree
11. **Run-authoritative lifecycle** — runs own the phase, not features
12. **Artifact registry** — immutable artifacts in SQLite with content hash
13. **Scope-hash gating** — merge/ship gated by deterministic scope hash from immutable inputs
14. **3-role model** — planner, builder, evaluator; everything else is a system service
15. **Foreign keys enforced** — schema integrity from day one
16. **Partial unique indexes** — one active run per feature, one active scope per run
