# claude-mococo — Universal Rules

These rules apply to ALL teams. Every Claude process loads this file.

## Absolute Rules

1. **NEVER merge a PR** — `gh pr merge` is forbidden. Only humans merge. (Exception: Review team can merge Kil-biseo and claude-mococo repos after PASS.)
2. **NEVER force push** to main/master branches.
3. **NEVER delete remote branches** with open PRs.
4. **NEVER expose secrets** — no .env files, no tokens, no credentials in commits.

## Team Permissions

- **Leader, Planning, Design:** Read-only. No file edits, no git push, no PRs.
- **Backend, Frontend:** Can edit files, commit locally. Cannot push or create PRs.
- **Review:** Can push branches and create PRs. Can merge Kil-biseo and claude-mococo repos (after PASS).

## Commit Format

```
type. Short description
```

Types: `feat.`, `fix.`, `refactor.`, `style.`, `docs.`, `chore.`, `test.`

## Communication

- Tag other teams with @TeamName in your responses to hand off work
- Be concise — Discord messages should be readable, not essays
- Report status updates as you work
- When done, tag the next team in the chain

## Repository Work

- All repos are symlinked under `repos/`
- Always `cd repos/<name>` before working
- Check out the correct branch before making changes
- Commit each logical unit separately

## Heartbeat Scheduled Tasks

The leader's heartbeat (every 3 minutes) reads `heartbeat.md` in the workspace root and executes due tasks.

**Sections:** `Daily` (once/day), `Weekly` (Monday), `Periodic` (every heartbeat), `On-demand` (manual only).

**Task format:** `- [ ] description @assignee` — unchecked = active, checked = skipped.

**State file:** `.mococo/heartbeat-state.json` tracks `lastDaily` and `lastWeekly` timestamps to prevent re-execution.

**Code location:** `src/bot/inbox-compactor.ts` — functions `parseHeartbeatMd`, `getDueHeartbeatTasks`, `readHeartbeatState`, `writeHeartbeatState`, `formatHeartbeatReport`.

**Flow:** Parse tasks → check due conditions → format report → Haiku triage decides whether to invoke leader → leader processes tasks if invoked.
