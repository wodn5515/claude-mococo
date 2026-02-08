#!/usr/bin/env bash
# claude-mococo setup script

set -e

echo "=== claude-mococo setup ==="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "Node.js is required. Install it: https://nodejs.org"
  exit 1
fi
echo "Node.js: $(node --version)"

# Check Claude CLI
if command -v claude &> /dev/null; then
  echo "Claude CLI: installed"
else
  echo "Claude CLI: NOT FOUND (required — install Claude Code)"
  exit 1
fi

# Check optional engines
if command -v codex &> /dev/null; then
  echo "Codex CLI: installed"
else
  echo "Codex CLI: not found (optional — npm install -g @openai/codex)"
fi

if command -v gemini &> /dev/null; then
  echo "Gemini CLI: installed"
else
  echo "Gemini CLI: not found (optional — npm install -g @google/gemini-cli)"
fi

echo ""

# Install dependencies
echo "Installing dependencies..."
npm install

# Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "Created .env from .env.example"
  echo "Edit .env with your Discord bot token and channel ID"
fi

# Create repos dir
mkdir -p repos
touch repos/.gitkeep

# Create runtime dirs
mkdir -p .mococo/conversations .mococo/logs

# Make hooks executable
chmod +x hooks/*.sh

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit .env with your DISCORD_TOKEN and WORK_CHANNEL_ID"
echo "  2. Link repos:  ln -s /path/to/project repos/my-app"
echo "  3. Start:       npm start"
echo "  4. Dev mode:    npm run dev"
