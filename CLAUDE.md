# claude-mococo — Universal Rules

These rules apply to ALL bots. Every Claude process loads this file.

## Absolute Rules

1. **NEVER merge a PR** — `gh pr merge` is forbidden. Only humans merge.
2. **NEVER force push** to main/master branches.
3. **NEVER delete remote branches** with open PRs.
4. **NEVER expose secrets** — no .env files, no tokens, no credentials in commits.

## Architecture (v1.0)

- Each bot runs as an independent process (`mococo run <id>`)
- Config stored at `~/.mococo/` (bots/, repos/, shared/)
- Two-phase execution: Triage (Haiku LLM) → Execution (claude --print in repo dir)
- Bots work directly in repo directories — repo's CLAUDE.md and .claude/ settings are used natively
- Shared repo worklog across all bots, per-bot personal memory

## Bot Permissions

- **Leader:** Read-only. No file edits, no git push, no PRs.
- **Backend, Frontend:** Can edit files, commit locally. Cannot push or create PRs.
- **Reviewer:** Can push branches and create PRs. Cannot merge.
- **Specialist (security, improver, etc.):** Read-only. Report only.

## Communication

- Tag other bots with @BotName in your responses to hand off work
- Be concise — Discord messages should be readable, not essays
- Report status updates as you work

## Repository Work

- Repos are configured per-bot in `~/.mococo/bots/<id>/config.json` as `allowedDirs`
- Bots `cd` to the actual repo directory to work
- Each repo's own CLAUDE.md and .claude/ settings are loaded natively by claude CLI
- Check out the correct branch before making changes
- Commit each logical unit separately

## Memory System

- **Bot personal memory** (`~/.mococo/bots/<id>/memory.md`): Personal state, tasks, context
- **Repo worklog** (`~/.mococo/repos/<name>/worklog.md`): Shared work history across all bots
- **Repo context** (`~/.mococo/repos/<name>/context.md`): Architecture, stack, conventions

## Schedule System

Bots can run autonomously via `schedule` config:
- `cron`: Run on a schedule (e.g. every 2 hours)
- `onIdle`: Run when no Discord activity for N minutes
- Results posted to `reportChannel`
