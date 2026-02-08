# claude-mococo

**Your personal AI team on Discord.** Specialized AI agents that live on Discord as separate bot users — each with its own Discord identity, GitHub account, and personality. Talk to them, and they coordinate work across your repositories.

```
You: "I need a user wishlist feature for my-app"

Leader (bot):    "So what we're building is a wishlist. @Planning analyze this."
Planning (bot):  "Here's the plan. @Backend build the API. @Frontend build the UI."
Backend (bot):   "API done. Ship it. @Frontend ready for you."
Frontend (bot):  "UI complete. @Review please review feat/user-wishlist."
Review (bot):    "LGTM. PR: github.com/mococo-review/my-app/pull/42"
```

Each team is a **real Discord bot** with its own profile. Each team pushes code with its **own GitHub account**.

---

## What You Need Per Team

Each team requires:

| Thing | Per Team | Notes |
|-------|----------|-------|
| Discord Application + Bot | 1 per team | Separate bot user in Discord |
| GitHub Account | 1 per team | Separate git author + push identity |
| GitHub PAT | 1 per team | For `gh` CLI operations (push, PRs) |
| AI Engine CLI | Shared | Same Claude/Codex/Gemini subscription |

**For the default 6 teams, you need:**
- 6 Discord Applications (each creates a bot user)
- 6 GitHub Accounts (each with a PAT token)
- 1 Discord Server with 1 work channel (all bots join here)
- 1 Node.js process (manages all bots)

**You can start small** — configure just 2-3 teams first, add more later.

---

## Installation Guide

### Step 1: Clone and Install

```bash
git clone https://github.com/YOUR_USER/claude-mococo.git
cd claude-mococo
npm install
```

### Step 2: Install AI Engine CLIs

```bash
# Claude CLI (required — main engine)
claude --version

# Codex CLI (optional — used by Planning team)
npm install -g @openai/codex

# Gemini CLI (optional — used by Design team)
npm install -g @google/gemini-cli
```

Don't have Codex or Gemini? Change the team's engine to `"claude"` in `teams.json`.

### Step 3: Create Discord Bots (One Per Team)

Repeat this for **each team** (Leader, Planning, Backend, Frontend, Review, Design):

#### 3a. Create the Discord Application

1. Go to https://discord.com/developers/applications
2. Click **"New Application"**
3. Name it after the team, e.g.:
   - `mococo-leader`
   - `mococo-planning`
   - `mococo-backend`
   - `mococo-frontend`
   - `mococo-review`
   - `mococo-design`
4. Click **"Create"**

#### 3b. Set Up the Bot

1. Left sidebar → **"Bot"**
2. (Optional) Upload a profile picture for this bot
   - Give each team a distinct avatar so they're easy to tell apart
3. Click **"Reset Token"** → **copy the token** → save it
4. Under **Privileged Gateway Intents**, enable:
   ```
   ✅ Presence Intent          → ON
   ✅ Server Members Intent    → ON
   ✅ Message Content Intent   → ON  ← CRITICAL
   ```
5. **Save Changes**

#### 3c. Invite the Bot to Your Server

1. Left sidebar → **"OAuth2"**
2. Under **Scopes**, check: `bot`
3. Under **Bot Permissions**, check:
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Attach Files`
4. Copy the generated URL → open in browser → select your server → **Authorize**

**Repeat 3a-3c for each team.** After you're done, you'll have 6 bots in your server.

#### 3d. Get the Work Channel ID

1. In Discord → **User Settings** → **Advanced** → enable **Developer Mode**
2. Right-click your work channel (e.g., `#mococo-work`) → **Copy Channel ID**

### Step 4: Create GitHub Accounts (One Per Team)

Each team gets its own GitHub account so commits and PRs show distinct authors.

#### 4a. Create the Accounts

Create a GitHub account for each team. Suggested usernames:

| Team | GitHub Username | Email |
|------|----------------|-------|
| Leader | `mococo-leader` | (any email) |
| Planning | `mococo-planning` | (any email) |
| Backend | `mococo-backend` | (any email) |
| Frontend | `mococo-frontend` | (any email) |
| Review | `mococo-review` | (any email) |
| Design | `mococo-design` | (any email) |

**Tip:** You can use email aliases (e.g., `you+mococo-backend@gmail.com`) for each account.

#### 4b. Generate Personal Access Tokens (PATs)

For each GitHub account:

1. Log in as that account
2. Go to https://github.com/settings/tokens?type=beta (Fine-grained tokens)
3. Click **"Generate new token"**
4. Name: `mococo`
5. Repository access: **All repositories** (or select specific ones)
6. Permissions:
   - **Contents**: Read and Write (for push)
   - **Pull requests**: Read and Write (for creating PRs)
   - **Metadata**: Read-only (required)
7. Click **"Generate token"** → copy it

**Important:** Only teams that push code truly need a PAT:
- **Must have PAT:** Backend, Frontend, Review (they commit/push)
- **Optional PAT:** Leader, Planning, Design (they only read/analyze)

#### 4c. Add Teams as Collaborators

For each repo the teams will work on:

1. Go to the repo → **Settings** → **Collaborators**
2. Add each team's GitHub account as a collaborator (Write access)

Or if using an organization, add the accounts to a team with write access.

#### 4d. Update teams.json Git Identities

Edit `teams.json` — update the `git.email` to use each account's noreply email.
This links commits to the GitHub profile:

```jsonc
"backend": {
  "git": {
    "name": "Sam (Backend)",
    "email": "mococo-backend@users.noreply.github.com"
  }
}
```

The noreply email format is: `USERNAME@users.noreply.github.com`

### Step 5: Configure Environment

```bash
cp .env.example .env
```

Fill in `.env` with all your tokens:

```bash
# ── Discord ──────────────────────────────────────────
WORK_CHANNEL_ID=1234567890123456789

# ── Discord Bot Tokens (one per team) ───────────────
LEADER_DISCORD_TOKEN=MTIz...your_leader_bot_token
PLANNING_DISCORD_TOKEN=NDU2...your_planning_bot_token
BACKEND_DISCORD_TOKEN=Nzg5...your_backend_bot_token
FRONTEND_DISCORD_TOKEN=MDEy...your_frontend_bot_token
REVIEW_DISCORD_TOKEN=MzQ1...your_review_bot_token
DESIGN_DISCORD_TOKEN=Njc4...your_design_bot_token

# ── GitHub PATs (one per team) ──────────────────────
BACKEND_GITHUB_TOKEN=github_pat_xxxxx
FRONTEND_GITHUB_TOKEN=github_pat_xxxxx
REVIEW_GITHUB_TOKEN=github_pat_xxxxx
# Teams that don't push can leave blank:
LEADER_GITHUB_TOKEN=
PLANNING_GITHUB_TOKEN=
DESIGN_GITHUB_TOKEN=

# ── Hook Server ─────────────────────────────────────
HOOK_PORT=9876
```

### Step 6: Link Your Repositories

```bash
ln -s /absolute/path/to/my-web-app repos/my-web-app
ln -s /absolute/path/to/my-api repos/my-api

# Verify
ls -la repos/
```

### Step 7: Start

```bash
npm start        # production
npm run dev      # development (auto-reload)
```

You should see:

```
Hook receiver listening on :9876
Starting 6 team bots...
  Leader bot online as @mococo-leader#1234
  Planning bot online as @mococo-planning#5678
  Backend bot online as @mococo-backend#9012
  Frontend bot online as @mococo-frontend#3456
  Review bot online as @mococo-review#7890
  Design bot online as @mococo-design#2345
claude-mococo running — 6/6 teams online (engines: claude, codex, gemini)
```

### Step 8: Test

In your Discord work channel:

```
!teams     → lists all teams (online/offline status)
!repos     → lists linked repositories
!status    → shows which teams are busy or idle
```

Try a request:

```
I need help analyzing repos/my-web-app
```

The Leader bot responds. To talk directly to a specific team, @mention that bot:

```
@mococo-backend can you check the API routes in repos/my-api?
```

---

## How It Works

### Each Team = Its Own Discord Bot

Unlike webhook-based approaches, each team is a **real Discord bot user**:

```
Discord Server:
  #mococo-work
    ├── mococo-leader (bot)     ← responds to all human messages
    ├── mococo-planning (bot)   ← responds when @mentioned
    ├── mococo-backend (bot)    ← responds when @mentioned
    ├── mococo-frontend (bot)   ← responds when @mentioned
    ├── mococo-review (bot)     ← responds when @mentioned
    └── mococo-design (bot)     ← responds when @mentioned
```

**Why separate bots?**
- Each team has its own profile picture and name in Discord
- You can @mention a specific team's bot directly
- Messages genuinely come FROM that bot (not a webhook impersonation)
- Each bot shows online/offline in the member list

### Each Team = Its Own GitHub Account

When Backend pushes code, it pushes as the `mococo-backend` GitHub user:

```
commit abc1234
Author: Sam (Backend) <mococo-backend@users.noreply.github.com>

Pull Request #42 by mococo-review
```

The `GH_TOKEN` env var is set per-team, so `gh` CLI operations use the team's GitHub account.

### Message Routing

```
Human types in #mococo-work
  │
  ├─ @mentions a specific bot? → That team responds
  │
  └─ No @mention? → Leader bot responds (only Leader watches all messages)

Team AI responds in Discord
  │
  ├─ Response mentions @OtherTeam? → That team is auto-invoked
  │
  └─ No mentions? → Done
```

### Multi-Engine

```
Each team has an engine configured in teams.json:
  ├─ "claude"  → claude -p (full agent: files, git, commands)
  ├─ "codex"   → codex (text-only: planning, analysis)
  └─ "gemini"  → gemini (text-only: design, large context)
```

---

## Teams

| Team | Bot Name | Character | Engine | Role |
|------|----------|-----------|--------|------|
| **Leader** | mococo-leader | Alex (CTO) | Claude | Delegates work |
| **Planning** | mococo-planning | Morgan | Codex | Creates plans |
| **Backend** | mococo-backend | Sam | Claude | Server code |
| **Frontend** | mococo-frontend | Riley | Claude | UI code |
| **Review** | mococo-review | Casey | Claude | Reviews, pushes, PRs |
| **Design** | mococo-design | Jordan | Gemini | UI/UX guidance |

---

## Customization

### Adding a New Team

1. Create a Discord Application + Bot (Step 3)
2. Create a GitHub Account + PAT (Step 4)
3. Add to `teams.json`:

```jsonc
"testing": {
  "name": "Testing",
  "color": "#F1C40F",
  "avatar": "test",
  "engine": "claude",
  "model": "sonnet",
  "maxBudget": 10,
  "prompt": "prompts/testing.md",
  "discordTokenEnv": "TESTING_DISCORD_TOKEN",
  "githubTokenEnv": "TESTING_GITHUB_TOKEN",
  "git": {
    "name": "Pat (Testing)",
    "email": "mococo-testing@users.noreply.github.com"
  },
  "permissions": {
    "deny": ["git push", "gh pr"]
  }
}
```

4. Add tokens to `.env`:
```
TESTING_DISCORD_TOKEN=xxx
TESTING_GITHUB_TOKEN=xxx
```

5. Create `prompts/testing.md` with personality and role.

6. Restart the bot.

### Starting Small (Minimum Setup)

You don't need all 6 teams to start. The minimum is:

```
Leader (required — routes human messages)
+ 1 worker team (e.g., Backend)
= 2 Discord bots + 2 GitHub accounts
```

Add more teams as needed.

### Repo-Specific Rules

Create `prompts/repo-specific/<repo-name>.md`:

```markdown
# Rules for my-web-app
- Use Tailwind CSS for styling
- Follow Django conventions
```

Auto-injected when a team works on that repo.

---

## Permissions

| Team | Edit Files | Push | Create PRs | Merge PRs |
|------|-----------|------|------------|-----------|
| Leader | No | No | No | No |
| Planning | No | No | No | No |
| Backend | Yes | No | No | No |
| Frontend | Yes | No | No | No |
| Review | Yes | Yes | Yes | **No** |
| Design | No | No | No | No |

**Global rule:** No team can ever merge a PR. Only humans merge.

---

## Discord Commands

| Command | What it does |
|---------|-------------|
| `!status` | Show busy/idle + online/offline for all teams |
| `!teams` | List teams with engines and online status |
| `!repos` | List linked repositories |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't respond | Enable **Message Content Intent** in that bot's Developer Portal settings |
| "No team has a Discord token" | Add `<TEAM>_DISCORD_TOKEN=xxx` to `.env` for each team |
| Only Leader responds | Other bots only respond to direct @mentions of their bot user |
| "command not found: codex" | Install `npm install -g @openai/codex` or change engine to `"claude"` |
| Team can't push to GitHub | Check that team's `<TEAM>_GITHUB_TOKEN` in `.env` is a valid PAT |
| Commits show wrong author | Update `git.email` in `teams.json` to match the GitHub account's noreply email |
| Permission denied on hooks | Run `chmod +x hooks/*.sh` |

---

## Project Structure

```
claude-mococo/
├── package.json
├── tsconfig.json
├── teams.json                # Team config (identity, engine, permissions, token env vars)
├── .env                      # All tokens (Discord per team, GitHub per team)
├── CLAUDE.md                 # Universal rules for all teams
│
├── src/
│   ├── index.ts              # Entry: start all team bots + hook server
│   ├── types.ts              # TypeScript types
│   ├── config.ts             # Load teams.json, resolve tokens from env
│   ├── bot/
│   │   ├── client.ts         # Creates one Discord.Client per team
│   │   ├── router.ts         # Message → Team routing
│   │   └── embeds.ts         # Rich embed builders
│   ├── teams/
│   │   ├── invoker.ts        # Build prompt → spawn engine → collect result
│   │   ├── context.ts        # In-memory conversation history
│   │   └── concurrency.ts    # Track busy teams, queue if needed
│   ├── orchestrator/
│   │   ├── engine-base.ts    # Abstract engine (shared git+github env)
│   │   ├── claude-engine.ts  # Claude CLI wrapper
│   │   ├── codex-engine.ts   # Codex CLI wrapper
│   │   ├── gemini-engine.ts  # Gemini CLI wrapper
│   │   ├── engines.ts        # Engine factory
│   │   └── prompt-builder.ts # Team prompt + context builder
│   └── server/
│       └── hook-receiver.ts  # HTTP server for hook events
│
├── hooks/
│   ├── event-bridge.sh       # Forward events to Discord
│   └── permission-gate.sh    # Enforce per-team permissions
│
├── prompts/                  # One personality per team
│   ├── leader.md, planning.md, backend.md,
│   ├── frontend.md, review.md, design.md
│   └── repo-specific/       # Per-repo rules
│
└── repos/                    # Symlinked repositories
```

## License

MIT
