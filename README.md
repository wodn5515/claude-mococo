# claude-mococo

**AI team company on Discord.** Multiple AI agents work together as distinct Discord bots — each with its own personality, GitHub identity, engine (Claude/Codex/Gemini), and permissions. Orchestration happens through Discord messages: human talks, agents coordinate, code gets committed and PRs get opened.

```
You: "Add a login page to my-app"

Leader (bot): "On it. @Backend please implement auth routes and login form."
Backend (bot): "Got it."
             → commits code → pushes branch
Review (bot): → reviews code → opens PR
```

---

## Quick Start

### 1. Install

```bash
npm install -g claude-mococo
```

Or run directly without installing:

```bash
npx claude-mococo init
npx claude-mococo add
npx claude-mococo start
```

You also need at least one AI engine:

```bash
claude --version                  # Claude CLI (recommended)
npm install -g @openai/codex      # Codex CLI (optional)
npm install -g @google/gemini-cli # Gemini CLI (optional)
```

### 2. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Name it anything (e.g. `my-assistant`)
3. Sidebar → **Bot**:
   - Copy the bot token
   - Enable all three **Privileged Gateway Intents** (Presence, Server Members, **Message Content**)
4. Sidebar → **OAuth2**:
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Embed Links`, `Attach Files`
   - Copy the URL → open in browser → add to your server

Repeat for each agent you plan to run.

### 3. Initialize and add assistants

```bash
mkdir my-team && cd my-team
mococo init                   # creates workspace (asks for Discord channel ID)
mococo add                    # interactive wizard — name, engine, tokens, etc.
```

Commits will show the assistant's name as the author (`git.name` in `teams.json`). For push and PR creation, provide a GitHub PAT during `mococo add`.

### 4. Link repos and start

```bash
ln -s /path/to/my-app repos/my-app
mococo start
```

Talk to your bot in the Discord channel. Done.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `mococo init` | Create a new workspace in the current directory |
| `mococo add` | Add an assistant (interactive wizard) |
| `mococo start` | Start all assistants |
| `mococo dev` | Start in dev mode with hot reload |
| `mococo list` | List configured assistants |
| `mococo edit <id>` | Edit assistant settings |
| `mococo remove <id>` | Remove an assistant |
| `mococo restart` | Trigger rebuild and restart |

---

## Team Architecture

A typical full team looks like this:

| Assistant | Engine | Model | Role | Permissions |
|-----------|--------|-------|------|-------------|
| **Leader** | Claude | opus | Coordinates team, delegates work, responds to all messages | Read-only |
| **Planner** | Codex | o3 | Creates architecture plans and specs | Read-only |
| **Backend** | Claude | sonnet | Implements server code, APIs, models | Edit files + local commits |
| **Frontend** | Claude | sonnet | Implements UI, components, CSS | Edit files + local commits |
| **Reviewer** | Claude | opus | Code review, branch push, PR creation | Push + PR create |
| **Designer** | Gemini | gemini-2.5-pro | UI/UX guidance (text advisor only) | Read-only |

You can start with just one assistant and add more over time.

---

## How It Works

### Message Routing

- No mention → the assistant marked `"isLeader": true` responds
- `@mention` a specific bot → that assistant responds
- An assistant mentions another → that assistant is automatically invoked

### Permissions

Controlled per-assistant in `teams.json`:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],
  "deny": ["gh pr merge"]
}
```

Typical permission tiers:
- **Leader / Planner / Designer:** Read-only. No file edits, no git.
- **Backend / Frontend:** Edit files, commit locally. No push or PRs.
- **Reviewer:** Push branches and open PRs. No merges.
- **All agents:** `gh pr merge` and `git push --force main/master` globally denied.

### Engines

- `"claude"` — full agent (files, git, shell commands via Claude CLI)
- `"codex"` — full agent via Codex CLI (OpenAI)
- `"gemini"` — text-only advisor (Gemini CLI)

### Memory & Inbox System

Each agent has an **inbox** (`.mococo/inbox/{id}.md`) where messages are appended as they arrive. When invoked, an agent receives:
- Recent conversation history (configurable window)
- Its inbox summary
- Consolidated long-term memory (`.mococo/memory/`)
- Shared rules from `CLAUDE.md`

A **Haiku model** (lightweight Claude) handles triage tasks: inbox summarization, improvement scanning, heartbeat decisions.

### Heartbeat & Scheduled Tasks

The leader runs a heartbeat every **3 minutes**. If `heartbeat.md` exists in the workspace root, it is parsed for scheduled tasks:

| Section | Frequency | Description |
|---------|-----------|-------------|
| `## Daily` | Once per day (first heartbeat) | Daily recurring tasks |
| `## Weekly` | Once per week (Monday, first heartbeat) | Weekly recurring tasks |
| `## Hourly` | Once per hour | Hourly monitoring tasks |
| `## Periodic` | Every heartbeat (~3 min) | Lightweight monitoring |
| `## On-demand` | Manual trigger only | One-off tasks |

Task format:

```markdown
- [ ] Task description @assignee
```

- `- [ ]` = active (processed)
- `- [x]` = inactive (skipped)
- `@assignee` = optional, routes to a specific assistant

State is tracked in `.mococo/heartbeat-state.json` to prevent re-running daily/weekly tasks.

### Dispatch Ledger

When the leader delegates work to another agent, it's recorded in a dispatch ledger. The leader tracks whether delegated work was completed and follows up if needed.

---

## Configuration Reference

### teams.json fields

| Field | Description |
|-------|-------------|
| `engine` | `"claude"`, `"codex"`, or `"gemini"` |
| `model` | Model name (e.g. `"sonnet"`, `"opus"`, `"o3"`, `"gemini-2.5-pro"`) |
| `maxBudget` | Max dollar spend per invocation (Claude only) |
| `prompt` | Path to the personality/instructions file |
| `isLeader` | If `true`, responds to all messages (not just @mentions) |
| `discordTokenEnv` | Environment variable name containing the bot token |
| `git.name` / `git.email` | Git author for commits |
| `permissions.allow` / `permissions.deny` | Allowed/denied shell commands |
| `mcpServers` | MCP server configurations (e.g. Google Calendar) |

### Global settings

| Field | Description |
|-------|-------------|
| `globalDeny` | Commands forbidden across all agents |
| `conversationWindow` | Number of recent messages in prompts (default: 30) |
| `humanTitle` | Title for the human user shown to agents (default: `"Boss"`) |

### Environment variables

```bash
WORK_CHANNEL_ID=              # Discord channel to work in (empty = all channels)
HOOK_PORT=9876                # HTTP webhook receiver port

# One token per bot
LEADER_DISCORD_TOKEN=...
BACKEND_DISCORD_TOKEN=...
FRONTEND_DISCORD_TOKEN=...
PLANNING_DISCORD_TOKEN=...
REVIEW_DISCORD_TOKEN=...
DESIGN_DISCORD_TOKEN=...

# Optional integrations
GOOGLE_OAUTH_CREDENTIALS=...  # Google Calendar MCP (for Leader)
GITHUB_PAT=...                # Required for push/PR
```

### Discord commands

| Command | Description |
|---------|-------------|
| `!status` | Show all assistants (busy/idle, engine, cost) |
| `!teams` | List assistants and their engines |
| `!repos` | List linked repositories |

---

## Manual Setup (without CLI)

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install
npm run build
```

Edit `teams.json` directly, create prompt files in `prompts/`, set tokens in `.env`, then run:

```bash
npm start
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Enable **Message Content Intent** in Discord Developer Portal |
| "No team has a Discord token" | Add the token env var to `.env` |
| Can't push to GitHub | Check the GitHub PAT in `.env` is valid |
| Wrong commit author | Set `git.email` to `USERNAME@users.noreply.github.com` |
| "command not found: codex" | Install it or change engine to `"claude"` |
| Heartbeat not triggering | Check `heartbeat.md` exists in workspace root |
| Agent loops indefinitely | Check `maxBudget` is set in `teams.json` |

---

## License

MIT
