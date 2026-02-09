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

const PERSONALITY_PRESETS: Record<string, string> = {
  'Professional — formal, thorough, structured': 'Professional and thorough. Communicates clearly with structured responses. Focuses on correctness and best practices.',
  'Casual — friendly, concise, direct': 'Casual and friendly. Keeps messages short and to the point. Uses a conversational tone.',
  'Mentor — patient, educational, explains why': 'Patient and educational. Explains the reasoning behind decisions. Takes time to teach, not just do.',
  'Custom': '',
};

export async function runAdd(): Promise<void> {
  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  console.log('Add a new assistant\n');

  // --- Identity ---
  console.log('── Identity ──');
  const id = await ask('Assistant ID (lowercase, e.g. coder)');
  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    console.error('ID must be lowercase alphanumeric (start with letter).');
    process.exit(1);
  }
  if (raw.teams[id]) {
    console.error(`Assistant "${id}" already exists.`);
    process.exit(1);
  }

  const name = await ask('Display name', id.charAt(0).toUpperCase() + id.slice(1));
  const role = await ask('Role description', 'AI assistant');

  // Personality
  const personalityNames = Object.keys(PERSONALITY_PRESETS);
  const personalityChoice = await choose('Personality:', personalityNames, 1);
  let personality = PERSONALITY_PRESETS[personalityChoice];
  if (!personality) {
    personality = await ask('Describe the personality');
  }

  // Expertise
  console.log('Expertise (comma-separated, e.g. "TypeScript, React, Node.js"):');
  const expertiseStr = await ask('  Skills', '');
  const expertise = expertiseStr
    ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Custom rules
  console.log('Custom rules (comma-separated, e.g. "Always write tests, Use ESLint"):');
  const rulesStr = await ask('  Rules', '');
  const rules = rulesStr
    ? rulesStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const isLeader = await confirm('Is this the leader (responds to all messages)?', false);

  // --- Engine ---
  console.log('\n── Engine ──');
  const engine = await choose('Engine:', ['claude', 'codex', 'gemini'], 0);
  const model = await ask('Model', ENGINE_DEFAULTS[engine] ?? 'sonnet');
  const budgetStr = await ask('Max budget per invocation ($)', '10');
  const maxBudget = parseFloat(budgetStr) || 10;

  // --- Tokens ---
  console.log('\n── Tokens ──');
  const discordToken = await ask('Discord bot token');
  const githubToken = await ask('GitHub PAT (optional, press enter to skip)');

  // --- Channels ---
  console.log('\n── Channels ──');
  console.log('Channel IDs this bot responds in (comma-separated, empty = all channels):');
  const channelsStr = await ask('  Channels', '');
  const channels = channelsStr
    ? channelsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // --- Permissions ---
  console.log('\n── Permissions ──');
  const presetNames = Object.keys(PERMISSION_PRESETS);
  const presetChoice = await choose('Permission preset:', presetNames, 1);
  const permissions = PERMISSION_PRESETS[presetChoice] ?? {};

  // --- Git identity ---
  console.log('\n── Git identity ──');
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
    ...(channels.length > 0 ? { channels } : {}),
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
    fs.writeFileSync(promptPath, generatePrompt({ name, role, personality, expertise, rules, isLeader }));
  }

  console.log(`\nAssistant "${name}" (${id}) added.`);
  console.log(`  Config:  teams.json`);
  console.log(`  Prompt:  prompts/${id}.md  (edit this for full control)`);
  console.log(`  Tokens:  .env`);
  console.log(`\nRun \`mococo start\` to launch.`);
}
