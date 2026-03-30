# AGENTS.md — cnog

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
cnog sling <feat>     # Propose contracts + spawn builders
cnog evaluate <feat>  # Spawn evaluator agent
cnog status           # Fleet overview
cnog run list         # List all runs
cnog run show <id>    # Show run details
cnog dashboard        # Live terminal UI
```

## Code Organisation

```
src/
├── index.ts           # CLI entry point
├── cli.ts             # yargs CLI router
├── types.ts           # Shared zod schemas + TS types
├── db.ts              # SQLite state (13 tables, WAL mode, FK enforced)
├── errors.ts          # Error catalog + CnogError
├── events.ts          # Structured event logging
├── tmux.ts            # tmux session management
├── worktree.ts        # Git worktree isolation
├── mail.ts            # Inter-agent messaging
├── overlay.ts         # Two-layer instruction generation
├── hooks.ts           # Claude Code hooks deployment
├── lifecycle.ts       # Run-authoritative state machine
├── agents.ts          # Agent lifecycle management
├── watchdog.ts        # Process monitoring + stall detection
├── memory.ts          # Issue-based work tracking
├── merge.ts           # FIFO merge queue + 4-tier resolution (scope-hash gated)
├── orchestrator.ts    # Main dispatch loop + restart recovery
├── dispatch.ts        # Plan-to-contract proposal (issue scheduling only)
├── execution.ts       # Builder spawning from accepted contracts
├── execution-spec.ts  # Execution spec construction
├── review.ts          # Review scope construction + evaluation verdict application
├── artifacts.ts       # Artifact persistence helpers
├── run-policy.ts      # Run advancement policy
├── contracts.ts       # Sprint contract negotiation + artifact registry
├── grading.ts         # Structured grading rubric + evaluation
├── checkpoint.ts      # Session checkpoint + handoff system
├── dashboard.ts       # Terminal dashboard
├── status.ts          # Run-level status snapshots
├── doctor.ts          # Health + integrity checks
├── config.ts          # YAML config loader + PID file management
├── paths.ts           # Centralized path constants + artifact paths
├── watchdog-policy.ts # Pure health evaluation policy
├── commands/          # CLI command handlers
├── runtimes/          # Pluggable agent runtime adapters
└── planning/          # Plan generation + delivery profiles

agents/                # Base agent definitions (3 roles)
├── builder.md         # Code implementation agent
├── evaluator.md       # Pre-build contract + post-build implementation gate
└── planner.md         # Prompt-to-plan expansion agent

tests/                 # vitest tests (32 files, 296 tests)
```

## Architecture

### Runs Are Authoritative

A **run** is the single authoritative execution unit. A feature is just a namespace.

Canonical run phases: `plan -> contract -> build -> evaluate -> merge -> ship -> done -> failed`

Rework is normal:
- `evaluate -> build` — implementation failed, scope valid
- `evaluate -> contract` — contract was wrong or incomplete
- `merge -> build` — conflicts reveal invalid assumptions
- `failed -> plan` — restart from scratch

### Four Planes

1. **State plane** — SQLite with 13 tables, FK enforced, WAL mode
2. **Execution plane** — tmux (dedicated socket `cnog`, one session per agent)
3. **Isolation plane** — git worktrees (one branch per agent)
4. **Coordination plane** — typed mail system

### 3-Role Model

| Role | Can Write | Purpose |
|------|-----------|---------|
| planner | No | Expand prompts into structured plans |
| builder | Yes | Implement code within file scope |
| evaluator | No | Gate contracts and score implementations |

System services (not agent roles): orchestrator, merge processor, watchdog, runtime adapter.

### Key Patterns

- **Artifact-first** — every important object is an immutable JSON artifact registered in SQLite
- **Evaluator gates twice** — pre-build (contract approval) and post-build (implementation scoring)
- **Scope-hash merge gating** — merge requires approved review scope with matching deterministic hash
- **Sprint contracts** — acceptance criteria negotiated before builders start, never auto-accepted
- **Restart recovery** — orchestrator can die and restart without losing truth

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
- Synchronous APIs (better-sqlite3, spawnSync)
- Single canonical enum per concept — no duplicates
- run_id required everywhere — FK enforced
- feature_phases is a derived projection — never read as authority

### Git
- Branch naming: `cnog/<feature>/<agent-name>`
- Commit format: `feat(scope): description` or `fix(scope): description`

## Testing

- Framework: vitest
- All tests must pass before committing
- Mock external dependencies (tmux, git) via vi.mock
- Tests must create runs before sessions/issues/merges (FK enforced)
- Use `tmpdir` for database tests
