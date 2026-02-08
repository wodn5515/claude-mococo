# claude-mococo — Universal Rules

These rules apply to ALL teams. Every Claude process loads this file.

## Absolute Rules

1. **NEVER merge a PR** — `gh pr merge` is forbidden. Only humans merge.
2. **NEVER force push** to main/master branches.
3. **NEVER delete remote branches** with open PRs.
4. **NEVER expose secrets** — no .env files, no tokens, no credentials in commits.

## Team Permissions

- **Leader, Planning, Design:** Read-only. No file edits, no git push, no PRs.
- **Backend, Frontend:** Can edit files, commit locally. Cannot push or create PRs.
- **Review:** Can push branches and create PRs. Cannot merge.

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
