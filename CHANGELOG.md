# Changelog

## [1.1.0] — 2026-04-16

### New Features

- **Self-modify via Discord chat**: Human can ask a bot to modify its own persona, memory, allowedDirs, schedule, or permissions through natural language. Security: only the user matching `humanDiscordId` can trigger self-modifications.
  - Examples: "persona에 ~ 추가해", "memory 초기화해", "allowedDirs에 /path 추가", "매 2시간마다 자동 실행"
- **Hot config reload**: Bot config is reloaded from disk on each message/trigger, so manual edits to `config.json` take effect without restart.
- **Auto-load `~/.mococo/.env`**: Discord tokens in `~/.mococo/.env` are auto-loaded at CLI startup. `mococo adopt` saves tokens automatically.
- **Wildcard in `allowedDirs`**: Use `"*"` to allow access to any directory.

## [1.0.0] — 2026-04-13

### Breaking Changes

Complete architecture redesign. **Not backward compatible with 0.x.**

- **Single-process → multi-process**: Each bot runs independently in its own terminal (`mococo run <id>`)
- **Central workspace → adoption center**: Config moved from `teams.json` in a workspace to `~/.mococo/` global directory
- **Prompt assembly → native execution**: Bots `cd` to repo directories and run `claude --print`, using the repo's own `CLAUDE.md` and `.claude/` settings natively
- **Symlinked repos → direct access**: No more `repos/` directory. Bots access repositories at their actual paths via `allowedDirs` config

### New Features

- **Two-phase execution**: Triage (Haiku LLM decides what to do) → Execution (claude --print in repo dir)
- **Schedule system**: Bots can auto-run via `cron` expressions or `onIdle` triggers
- **Specialist bots**: Create read-only bots for security scanning, code improvement, test analysis, etc.
- **Shared repo worklog**: All bots share a work history per repo (`~/.mococo/repos/<name>/worklog.md`)
- **Per-bot personal memory**: Each bot maintains its own memory (`~/.mococo/bots/<id>/memory.md`)
- **Adoption center CLI**: `mococo init`, `mococo adopt`, `mococo run`, `mococo list`, `mococo release`

### Removed

- `mococo start` (all-in-one) — replaced by `mococo run <id>` (one bot per terminal)
- `mococo add` / `mococo remove` — replaced by `mococo adopt` / `mococo release`
- `mococo dev` / `mococo restart` — not needed (just restart the process)
- `teams.json` — replaced by per-bot `config.json` in `~/.mococo/bots/<id>/`
- `repos/` symlink directory — bots access repos directly
- Hook system (`hooks/`, `event-bridge.sh`, `permission-gate.sh`)
- Heartbeat system (replaced by per-bot `schedule` config)
- Improvement scanner (replaced by specialist bots)
- Inbox compactor, dispatch ledger, stress tracker
- Codex and Gemini engine support (Claude only for now)
- MCP server config in bot config (repos bring their own MCP via `.claude/`)

### Migration from 0.x

1. Run `mococo init` to create `~/.mococo/`
2. For each bot in your old `teams.json`, run `mococo adopt <id>`
3. Copy persona content from old `prompts/<name>.md` to `~/.mococo/bots/<id>/persona.md`
4. Set Discord tokens as environment variables
5. Run each bot in a separate terminal: `mococo run <id>`

---

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
