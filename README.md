# claude-mococo

[한국어](README.ko.md)

**AI assistants on Discord.** Each assistant is a real Discord bot backed by an AI engine (Claude, Codex, Gemini). It has its own GitHub identity, personality, and permissions. Start with one, add more when you need them.

```
You: "Add a login page to my-app"

Assistant (bot): "On it. I'll create the auth routes and login form."
               → commits code → pushes branch → opens PR
```

---

## Quick Start

### 1. Install

```bash
npm install -g claude-mococo
```

You also need at least one AI engine CLI:

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

> Repeat this for each assistant you want to run (each needs its own Discord bot).

### 3. Initialize and add your assistant

```bash
mkdir my-team && cd my-team
mococo init                   # creates workspace
mococo add                    # interactive wizard
```

Both `init` and `add` support a language flag:

```bash
mococo init --lang ko         # Korean prompts
mococo add --lang en          # English prompts (default)
```

If `--lang` is omitted, you'll be asked at the start: `Use Korean? (한국어로 진행할까요?) [y/N]`

### 4. Link your repos and start

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
| `mococo edit <id>` | Edit an assistant's settings |
| `mococo start` | Start all assistants |
| `mococo dev` | Start in dev mode (auto-rebuild on trigger) |
| `mococo restart` | Trigger rebuild + restart (use with `dev`) |
| `mococo list` | List configured assistants |
| `mococo remove <id>` | Remove an assistant |

**Global option:** `--lang <en|ko>` — set CLI language for `init`, `add`, and `edit`.

---

## Detailed Command Reference

### `mococo init`

Creates a new workspace or updates an existing one.

```bash
mkdir my-team && cd my-team
mococo init
```

**What you'll see:**

```
Use Korean? (한국어로 진행할까요?) [y/N]: N

Initializing workspace...

Discord work channel ID (leave empty for all channels): 1234567890123456
Your Discord user ID (right-click your name → Copy User ID): 9876543210987654

Workspace created:
  teams.json   — assistant configuration
  .env         — tokens and settings
  prompts/     — personality files
  repos/       — linked repositories
  hooks/       — Claude Code hooks

Next: run `mococo add` to add your first assistant.
```

**Created files:**

| File/Directory | Purpose |
|----------------|---------|
| `teams.json` | Main configuration — all assistant definitions |
| `.env` | Tokens and environment variables |
| `.gitignore` | Excludes `.env`, `.mococo/`, `repos/*` |
| `prompts/` | Personality files for each assistant |
| `prompts/shared-rules.md` | Common rules shared by all assistants |
| `repos/` | Symlinks to your actual repositories |
| `hooks/` | Claude Code git hooks |
| `.mococo/` | Internal state directory |

**Re-initialization:** If `teams.json` already exists, `mococo init` preserves all assistants and only updates global settings (channel ID, user ID, hooks).

---

### `mococo add`

Interactive wizard to add a new AI assistant. Walks you through every configuration option.

```bash
mococo add
# or with Korean prompts:
mococo add --lang ko
```

**Full wizard walkthrough:**

```
Use Korean? (한국어로 진행할까요?) [y/N]: N

Add a new agent

── Identity ──
Assistant ID (lowercase, e.g. hr): backend
Display name (e.g. Backend) (Backend): Backend Dev
Is this the leader (responds to all messages)? [y/N]: N

── Character ──
MBTI:
  > 1. ENTJ — Strategist, decisive, big-picture leader
    2. ISTJ — Rule-follower, systematic, accuracy-focused
    3. ENFJ — People-oriented, empathetic, team harmony
    4. INTP — Analytical, logical, deep explorer
    5. Custom
Choice (1): 2

Speech style:
  > 1. Formal to everyone
    2. Formal to human + casual to peers
    3. Custom
Choice (1): 2

Personality traits (with behavior examples, comma-separated):
  e.g. "Systematic — structures all requirements, Cautious — verifies when unsure"
  Traits: Detail-oriented — catches edge cases, Efficient — minimal code for max effect

Habits (comma-separated):
  e.g. "Reports in conclusion→evidence→next-steps order"
  Habits: Always writes tests first, Documents API changes immediately

── Role ──
Core role (1-2 sentences): Backend developer handling API design, database, and server logic.

Scope (comma-separated):
  Scope: API development, Database design, Server architecture

Not in scope (comma-separated):
  Not in scope: UI/UX, Frontend styling

Independent decisions: API structure, DB schema, code style
Needs approval for: Major architecture changes, New framework adoption

Expertise (comma-separated):
  Expertise: Python, FastAPI, PostgreSQL, Docker

Additional rules (comma-separated):
  Rules: Always validate inputs, Never expose internal errors to clients

Enable agent team mode (parallel sub-agents)? [y/N]: N

── Engine ──
Engine:
  > 1. claude
    2. codex
    3. gemini
Choice (1): 1
Model (sonnet): opus
Max budget per invocation ($) (10): 10

── Tokens ──
Discord bot token: MTIz...your-token-here

── Channels ──
Channel IDs this bot responds in (comma-separated, empty = all channels):
  Channels:

── Permissions ──
Permission preset:
    1. Full — can push, create PRs
  > 2. Developer — can edit files, no push
    3. Read-only — no edits, no push
Choice (2): 1

── Git identity ──
Git author name (Backend Dev (mococo)): Backend Dev
Git author email (backend@users.noreply.github.com):

"Backend Dev" (backend) added successfully.
  Config:  teams.json
  Prompt:  prompts/backend.md  (editable)
  Tokens:  .env

Run `mococo start` to launch.
```

**What gets created:**
- Entry in `teams.json` with all settings
- `{ID}_DISCORD_TOKEN=...` appended to `.env`
- `prompts/{id}.md` — auto-generated personality file (fully editable)

---

### `mococo edit <id>`

Edit an existing assistant's configuration.

```bash
mococo edit backend
```

**Menu:**

```
Editing assistant "Backend Dev" (backend)

What to edit:
  > 1. name        — Display name
    2. character   — MBTI, speech style, personality, habits
    3. role        — Scope, authority, expertise
    4. engine      — Engine and model
    5. budget      — Max budget
    6. channels    — Channel restrictions
    7. permissions — Permission preset
    8. git         — Git author identity
    9. all         — Edit everything
Choice (8):
```

- Editing **character** or **role** offers to regenerate the persona file (`prompts/{id}.md`)
- You can edit individual sections or choose `all` to walk through everything

---

### `mococo list` / `mococo ls`

Display all configured assistants in a table.

```bash
mococo list
```

**Example output:**

```
  ID               Name             Engine     Model              Leader
  ──────────────── ──────────────── ────────── ────────────────── ──────
  leader           Team Lead        claude     sonnet             yes
  backend          Backend Dev      claude     opus
  designer         Designer         gemini     gemini-2.5-pro
```

---

### `mococo remove <id>` / `mococo rm <id>`

Remove an assistant and clean up all related files.

```bash
mococo remove backend
```

**What gets removed:**
- Entry from `teams.json`
- `prompts/{id}.md` — personality file
- `{ID}_*` token lines from `.env`

---

### `mococo start`

Start all configured assistants.

```bash
mococo start
```

**What happens:**
1. Loads `.env` from workspace
2. Loads `teams.json` configuration
3. Validates Discord tokens are present for each assistant
4. Starts the HTTP hook receiver (default port: 9876)
5. Creates Discord bots for each assistant with a valid token

**Output:**

```
Starting 3 assistant(s)...
mococo running — 3/3 assistants online (engines: claude, gemini)
```

**Requirements:**
- Must run from within a mococo workspace (directory with `teams.json`)
- Each assistant needs `{ID}_DISCORD_TOKEN` set in `.env`

---

### `mococo dev`

Start in development mode with auto-rebuild. Watches for restart triggers.

```bash
mococo dev
```

Uses `nodemon` to watch for changes. When triggered, rebuilds TypeScript and restarts the bot.

---

### `mococo restart`

Trigger a rebuild and restart when running in `dev` mode.

```bash
# In another terminal while `mococo dev` is running:
mococo restart
```

---

## Configuration Reference

### teams.json

Main configuration file. Created by `mococo init`, updated by `mococo add`/`edit`.

```jsonc
{
  "teams": {
    "leader": {
      "name": "Team Lead",
      "color": "#5865F2",
      "avatar": "crown",
      "engine": "claude",
      "model": "sonnet",
      "maxBudget": 10,
      "prompt": "prompts/leader.md",
      "isLeader": true,
      "useTeams": false,
      "channels": [],
      "git": {
        "name": "Team Lead",
        "email": "leader@users.noreply.github.com"
      },
      "permissions": {
        "allow": ["git push", "gh pr create"],
        "deny": ["gh pr merge"]
      },
      "mcpServers": {}
    }
  },
  "globalDeny": ["gh pr merge", "git push --force main", "git push --force master"],
  "conversationWindow": 30,
  "humanDiscordId": "123456789012345678",
  "humanTitle": "Boss"
}
```

**Per-assistant fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name in Discord |
| `color` | hex string | Discord embed color |
| `avatar` | string | Avatar key (`robot`, `crown`, `brain`, `gear`, `palette`, `shield`, `eye`, `test`, `book`) |
| `engine` | string | `"claude"`, `"codex"`, or `"gemini"` |
| `model` | string | Model name (e.g. `"sonnet"`, `"opus"`, `"o3"`, `"gemini-2.5-pro"`) |
| `maxBudget` | number | Max dollar spend per invocation (Claude only) |
| `prompt` | string | Path to the personality/instructions file |
| `isLeader` | boolean | If `true`, responds to all messages (not just @mentions) |
| `useTeams` | boolean | Enable agent team mode (parallel sub-agents) |
| `teamRules` | string[] | Rules for sub-agent behavior |
| `channels` | string[] | Channel IDs to respond in (empty = all) |
| `discordUserId` | string | Auto-populated on first bot login |
| `git.name` | string | Git commit author name |
| `git.email` | string | Git commit author email |
| `mcpServers` | object | MCP server configurations (env vars use `$VAR` syntax) |
| `permissions.allow` | string[] | Allowed shell commands |
| `permissions.deny` | string[] | Denied shell commands |

**Global fields:**

| Field | Type | Description |
|-------|------|-------------|
| `globalDeny` | string[] | Commands denied for all assistants |
| `conversationWindow` | number | Number of recent messages to include as context |
| `humanDiscordId` | string | Your Discord user ID |
| `humanTitle` | string | How assistants address you (e.g. "Boss", "Admin") |

### .env

Environment variables. Created by `mococo init`.

```bash
# Required
WORK_CHANNEL_ID=1234567890123456   # Leave empty for all channels
HOOK_PORT=9876                      # HTTP webhook receiver port

# Optional
MEMBER_TRACKING_CHANNEL_ID=         # Channel for member events
DECISION_LOG_CHANNEL_ID=            # Channel for leader decision logs
GITHUB_TOKEN=ghp_xxxxx             # GitHub PAT for push/PR operations

# One per assistant (auto-added by `mococo add`)
LEADER_DISCORD_TOKEN=your-token-here
BACKEND_DISCORD_TOKEN=your-token-here
```

### prompts/{id}.md

Auto-generated personality file. Fully editable — this is where each assistant's character, role, and rules are defined.

**Generated structure:**

```markdown
# Assistant Name

You are **Assistant Name**, an AI assistant on Discord.
When addressing the human, always call them **Boss**.

## Character
- **MBTI:** ISTJ — Rule-follower, systematic, accuracy-focused
- **Speech style:**
  - To the human: strictly formal and respectful
  - To other agents: casual and direct
- **Personality:**
  - Detail-oriented — catches edge cases
- **Habits:**
  - Always writes tests first

## Role
Backend developer handling API design and server logic.

**Scope:**
- API development
- Database design

**Not in scope:**
- UI/UX

**Decision authority:**
- Independent: API structure, DB schema
- Needs approval: Major architecture changes

## Expertise
- Python
- FastAPI

## Rules
- Always validate inputs
```

### prompts/shared-rules.md

Common rules automatically included for all assistants. Copied from `defaults/shared-rules.md` during `mococo init`. Covers:
- Priority hierarchy (Rules > Role > Personality)
- Command chain (human > leader > self)
- Absolute prohibitions (no merging, no credential exposure)
- Tag and conversation management
- Memory and behavior guidelines
- New agent welcome protocol

Uses `{{humanTitle}}` and `{{leaderName}}` placeholders that are replaced at runtime.

---

## Usage Scenarios

### Scenario 1: Single Assistant

The simplest setup — one bot that handles everything.

```bash
mkdir my-project && cd my-project
mococo init
mococo add
# → ID: assistant, Engine: claude, Model: opus
# → Permission: Full

ln -s /path/to/my-app repos/my-app
mococo start
```

Now mention `@assistant` in Discord:

```
You: @assistant Add input validation to the signup form
Bot: I'll add validation for email format, password strength, and required fields.
     → makes changes → commits → pushes → opens PR
```

### Scenario 2: Multi-Assistant Team

A team with a leader that delegates to specialists.

```bash
mkdir my-team && cd my-team
mococo init

# Add a leader (responds to all messages, delegates work)
mococo add
# → ID: leader, isLeader: yes, Engine: claude, Model: sonnet
# → Permission: Read-only (leader doesn't code — it delegates)

# Add a backend developer
mococo add
# → ID: backend, Engine: claude, Model: opus
# → Permission: Full

# Add a frontend developer
mococo add
# → ID: frontend, Engine: claude, Model: opus
# → Permission: Full

# Link repos
ln -s /path/to/api repos/api
ln -s /path/to/web repos/web
mococo start
```

Now talk in the Discord channel (no @mention needed — the leader picks it up):

```
You: Build a user profile page with an API endpoint

Leader: I'll coordinate this.
        @backend Create GET /api/users/:id endpoint
        @frontend Build the profile page component

Backend: Working on the API endpoint...
         → commits code → pushes → opens PR

Frontend: Building the profile component...
          → commits code → pushes → opens PR
```

---

## How It Works

**Message routing:**
- `@mention` a specific bot → that assistant responds
- No mention → the assistant marked `"isLeader": true` responds

**Cross-assistant invocation:**
When an assistant mentions another (e.g. `@Backend please check this`) → that assistant is automatically invoked.

**Engines:**
- `"claude"` — Full agent with file editing, git operations, shell commands
- `"codex"` — Text-only advisor
- `"gemini"` — Text-only advisor

**Permissions** are controlled per-assistant:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],   // explicitly allowed
  "deny": ["gh pr merge"]                   // explicitly denied
}
```

**Discord commands** (type in chat):

| Command | Description |
|---------|-------------|
| `!status` | Show all assistants (busy/idle, online/offline) |
| `!teams` | List assistants and their engines |
| `!repos` | List linked repositories |

---

## Workspace Structure

After setup, your workspace looks like this:

```
my-team/
├── teams.json              # Assistant configurations
├── .env                    # Tokens and settings
├── .gitignore              # Excludes .env, .mococo/, repos/*
├── prompts/
│   ├── shared-rules.md     # Common rules for all assistants
│   ├── leader.md           # Leader personality
│   ├── backend.md          # Backend personality
│   └── frontend.md         # Frontend personality
├── repos/
│   ├── .gitkeep
│   ├── api -> /path/to/api         # Symlink
│   └── web -> /path/to/web         # Symlink
├── hooks/                  # Claude Code git hooks
└── .mococo/                # Internal state
```

---

## Manual Setup (without CLI)

You can also set up manually by cloning the repo:

```bash
git clone https://github.com/wodn5515/claude-mococo.git
cd claude-mococo
npm install
npm run build
```

Edit `teams.json` directly, create prompt files in `prompts/`, set tokens in `.env`, then `npm start`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Enable **Message Content Intent** in Discord Developer Portal |
| "No assistant has a Discord token" | Add the token to `.env` (`{ID}_DISCORD_TOKEN=...`) |
| Can't push to GitHub | Set `GITHUB_TOKEN` in `.env` with a valid PAT |
| Wrong commit author | Set `git.email` to `USERNAME@users.noreply.github.com` |
| "command not found: codex" | Install it (`npm i -g @openai/codex`) or change engine to `"claude"` |
| Bot responds in wrong channel | Set `channels` in `teams.json` or `WORK_CHANNEL_ID` in `.env` |

---

## License

MIT
