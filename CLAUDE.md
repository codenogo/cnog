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
cnog init          # Initialize project
cnog doctor        # Health check
cnog sling <feat>  # Spawn agent
cnog status        # Fleet overview
```

## Code Organisation

```
src/
├── index.ts           # CLI entry point
├── cli.ts             # yargs CLI — all commands
├── types.ts           # Shared zod schemas + TS types
├── db.ts              # SQLite state (10 tables, WAL mode)
├── errors.ts          # Error catalog + CnogError
├── events.ts          # Structured event logging
├── tmux.ts            # tmux session management
├── worktree.ts        # Git worktree isolation
├── mail.ts            # Inter-agent messaging
├── overlay.ts         # Two-layer instruction generation
├── lifecycle.ts       # Feature state machine
├── agents.ts          # Agent lifecycle management
├── watchdog.ts        # Process monitoring + stall detection
├── memory.ts          # Issue-based work tracking
├── merge.ts           # FIFO merge queue + 4-tier resolution
├── orchestrator.ts    # Main dispatch loop
├── dispatch.ts        # Plan-to-agent bridge
├── dashboard.ts       # Terminal dashboard
└── planning/
    ├── index.ts
    ├── profiles.ts    # Delivery policy profiles
    └── plan-factory.ts # Plan generation + validation

agents/                # Base agent definitions (Layer 1)
├── builder.md
├── scout.md
├── reviewer.md
├── merger.md
├── lead.md
└── coordinator.md

tests/                 # vitest tests
```

## Architecture

The orchestrator has four planes:
1. **State plane** — SQLite (sessions, messages, merge_queue, runs, metrics, events, feature_phases, issues)
2. **Execution plane** — tmux (dedicated socket `cnog`, one session per agent)
3. **Isolation plane** — git worktrees (one branch per agent)
4. **Coordination plane** — typed mail system (status, result, error, worker_done, merge_ready, escalation)

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

### Git
- Branch naming: `cnog/<feature>/<agent-name>`
- Commit format: `feat(scope): description` or `fix(scope): description`

## Testing

- Framework: vitest
- All tests must pass before committing
- Mock external dependencies (tmux, git) via vi.mock
- Use `tmpdir` for database tests

## Key Design Decisions

1. **SQLite via better-sqlite3** — synchronous API matches Python's sqlite3
2. **tmux, not subprocess** — human can attach to any agent session
3. **yargs, not commander** — rich subcommand support with type inference
4. **zod for validation** — runtime + compile-time type safety
5. **Synchronous core** — spawnSync for shell commands matches Python behavior
6. **ESM throughout** — modern Node.js module system
