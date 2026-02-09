import fs from 'node:fs';
import path from 'node:path';
import { ask, confirm, choose, closeRL } from '../readline-utils.js';
import { generatePrompt } from '../prompt-template.js';
import { requireWorkspace } from '../workspace.js';

const ENGINE_DEFAULTS: Record<string, string> = {
  claude: 'sonnet',
  codex: 'o3',
  gemini: 'gemini-2.5-pro',
};

const PERMISSION_PRESETS: Record<string, { allow?: string[]; deny?: string[] }> = {
  'Full — can push, create PRs': {
    allow: ['git push', 'gh pr create'],
    deny: ['gh pr merge'],
  },
  'Developer — can edit files, no push': {
    deny: ['git push', 'gh pr'],
  },
  'Read-only — no edits, no push': {
    deny: ['git push', 'gh pr', 'Edit', 'Write'],
  },
};

const AVATAR_KEYS = ['robot', 'crown', 'brain', 'gear', 'palette', 'shield', 'eye', 'test', 'book'];

export async function runAdd(): Promise<void> {
  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  console.log('Add a new assistant\n');

  // 1. ID
  const id = await ask('Assistant ID (lowercase, e.g. coder)');
  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    console.error('ID must be lowercase alphanumeric (start with letter).');
    process.exit(1);
  }
  if (raw.teams[id]) {
    console.error(`Assistant "${id}" already exists.`);
    process.exit(1);
  }

  // 2. Display name
  const name = await ask('Display name', id.charAt(0).toUpperCase() + id.slice(1));

  // 3. Role
  const role = await ask('Role (one line description)', `AI assistant`);

  // 4. Engine
  const engine = await choose('Engine:', ['claude', 'codex', 'gemini'], 0);

  // 5. Model
  const model = await ask('Model', ENGINE_DEFAULTS[engine] ?? 'sonnet');

  // 6. Max budget
  const budgetStr = await ask('Max budget per invocation ($)', '10');
  const maxBudget = parseFloat(budgetStr) || 10;

  // 7. Discord token
  const discordToken = await ask('Discord bot token');

  // 8. GitHub PAT
  const githubToken = await ask('GitHub PAT (optional, press enter to skip)');

  // 9. Leader?
  const isLeader = await confirm('Is this the leader (responds to all messages)?', false);

  // 10. Permission preset
  const presetNames = Object.keys(PERMISSION_PRESETS);
  const presetChoice = await choose('Permission preset:', presetNames, 1);
  const permissions = PERMISSION_PRESETS[presetChoice] ?? {};

  // 11. Git identity
  const gitName = await ask('Git author name', `${name} (mococo)`);
  const gitEmail = await ask('Git author email', `mococo-${id}@users.noreply.github.com`);

  // Pick an avatar
  const usedAvatars = new Set(Object.values(raw.teams as Record<string, any>).map((t: any) => t.avatar));
  const avatar = AVATAR_KEYS.find(k => !usedAvatars.has(k)) ?? 'robot';

  closeRL();

  // Write to teams.json
  raw.teams[id] = {
    name,
    color: '#5865F2',
    avatar,
    engine,
    model,
    maxBudget,
    prompt: `prompts/${id}.md`,
    ...(isLeader ? { isLeader: true } : {}),
    git: { name: gitName, email: gitEmail },
    permissions,
  };
  fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');

  // Append tokens to .env
  const envPath = path.join(ws, '.env');
  const envLines: string[] = [];
  envLines.push(`${id.toUpperCase()}_DISCORD_TOKEN=${discordToken}`);
  if (githubToken) {
    envLines.push(`${id.toUpperCase()}_GITHUB_TOKEN=${githubToken}`);
  }
  fs.appendFileSync(envPath, envLines.join('\n') + '\n');

  // Generate prompt file
  const promptPath = path.join(ws, 'prompts', `${id}.md`);
  if (!fs.existsSync(promptPath)) {
    fs.writeFileSync(promptPath, generatePrompt({ name, role, isLeader }));
  }

  console.log(`\nAssistant "${name}" (${id}) added.`);
  console.log(`  Config:  teams.json`);
  console.log(`  Prompt:  prompts/${id}.md`);
  console.log(`  Tokens:  .env`);
  console.log(`\nRun \`mococo start\` to launch.`);
}
