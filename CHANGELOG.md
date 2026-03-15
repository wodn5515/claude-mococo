# Changelog

All notable changes to this project will be documented in this file.

## [0.9.0] - 2026-03-15

### Features
- Stress-based persona system — bot personality adapts dynamically based on stress/workload levels (#73)
- Agent stress system + heartbeat TaskRegistry overhaul (#79)
- AGENT.md system — auto-loads repo-specific AI agent context files (#84)

### Bug Fixes
- Memory leak — duplicate timer registration & resource leak on login failure (#69)
- Race condition — 6 concurrent access bugs fixed (#70)
- Improvement scanner false positive reduction (#71)
- Cooldown Maps memory leak fix & duplicate start prevention (#87)
- `appendToInbox` race condition — clearTimeout timing fix (#88)
- Remove internal team settings from open-source repo (#89)

### Refactor
- Prompt token optimization — condensed mode for repeat invocations (#74)

### Docs
- README EN/KO full revision for v0.8.0 (#66, #67)
- Checker merge policy documentation (#75)

## [0.8.0] - 2026-03-09

### Features
- Multi-engine support (Claude, Codex, Gemini)
- Heartbeat & scheduled task system
- Dispatch ledger for leader delegation tracking
- Agent Teams (sub-agent spawning)
- Memory system (long-term + short-term)
- Inbox system for leader
- Hook system (event-bridge, permission-gate)
- CLI commands (init, add, start, dev, list, edit, remove, restart)
- Discord commands (!status, !teams, !repos)
- MCP server integration (stdio + HTTP)
- Shared rules with placeholder support
- Repo-specific rules auto-injection
