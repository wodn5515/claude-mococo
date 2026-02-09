# claude-mococo

**AI assistants on Discord.** Each assistant is a real Discord bot backed by an AI engine (Claude, Codex, Gemini). It has its own GitHub account, personality, and permissions. Start with one, add more when you need them.

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

### 3. Create a GitHub account for the bot

So commits and PRs show as coming from the assistant, not you.

1. Create a GitHub account (e.g. `my-assistant-bot`)
2. [Generate a fine-grained PAT](https://github.com/settings/tokens?type=beta) with:
   - **Contents**: Read and Write
   - **Pull requests**: Read and Write
   - **Metadata**: Read-only
3. Add this account as a collaborator to your repos

### 4. Initialize and add your assistant

```bash
mkdir my-team && cd my-team
mococo init                   # creates workspace (asks for Discord channel ID)
mococo add                    # interactive wizard — asks for name, engine, tokens, etc.
```

### 5. Link your repos and start

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
| `mococo list` | List configured assistants |
| `mococo remove <id>` | Remove an assistant |

---

## Adding More Assistants

```bash
mococo add        # repeat for each new assistant
```

Each one gets:
- Its own Discord bot (separate identity in chat)
- Its own GitHub account (separate commit author)
- Its own entry in `teams.json` (engine, personality, permissions)

You can build a full team this way:

| Assistant | Engine | Role |
|-----------|--------|------|
| Leader | Claude | Delegates work to other assistants |
| Planner | Codex | Creates plans and specs |
| Coder | Claude | Writes code |
| Reviewer | Claude | Reviews and opens PRs |
| Designer | Gemini | UI/UX guidance |

Or just run a single assistant. It's up to you.

---

## How It Works

**Message routing:**
- If you `@mention` a specific bot → that assistant responds
- If no mention → the first assistant marked `"isLeader": true` responds

**When an assistant mentions another** (e.g. `@Reviewer please check this`) → that assistant is automatically invoked.

**Permissions** are controlled per-assistant in `teams.json`:

```jsonc
"permissions": {
  "allow": ["git push", "gh pr create"],
  "deny": ["gh pr merge"]
}
```

**Engines:** `"claude"` runs as a full agent (files, git, commands). `"codex"` and `"gemini"` run as text-only advisors.

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
| `git.name` / `git.email` | Git author for commits |
| `permissions.allow` / `permissions.deny` | Allowed/denied shell commands |

### Discord commands

| Command | Description |
|---------|-------------|
| `!status` | Show all assistants (busy/idle, online/offline) |
| `!teams` | List assistants and their engines |
| `!repos` | List linked repositories |

---

## Manual Setup (without CLI)

You can also set up manually by cloning the repo:

```bash
git clone https://github.com/anthropics/claude-mococo.git
cd claude-mococo
npm install
```

Edit `teams.json` directly, create prompt files in `prompts/`, set tokens in `.env`, then `npm start`.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Enable **Message Content Intent** in Discord Developer Portal |
| "No team has a Discord token" | Add the token env var to `.env` |
| Can't push to GitHub | Check the GitHub PAT in `.env` is valid |
| Wrong commit author | Set `git.email` to `USERNAME@users.noreply.github.com` |
| "command not found: codex" | Install it or change engine to `"claude"` |

## License

MIT
