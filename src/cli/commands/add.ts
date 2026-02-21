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

const MBTI_PRESETS: Record<string, string> = {
  'ENTJ — Strategist, decisive, big-picture leader': 'ENTJ — Strategist, decisive, big-picture leader',
  'ISTJ — Rule-follower, systematic, accuracy-focused': 'ISTJ — Rule-follower, systematic, accuracy-focused',
  'ENFJ — People-oriented, empathetic, team harmony': 'ENFJ — People-oriented, empathetic, team harmony',
  'INTP — Analytical, logical, deep explorer': 'INTP — Analytical, logical, deep explorer',
  'Custom': '',
};

const SPEECH_PRESETS: Record<string, string> = {
  'Formal to everyone': [
    '  - To the human: formal and respectful',
    '  - To the leader: formal and respectful',
    '  - To other agents: polite and professional',
  ].join('\n'),
  'Formal to human + casual to peers': [
    '  - To the human: strictly formal and respectful',
    '  - To other agents: casual and direct',
  ].join('\n'),
  'Custom': '',
};

export async function runAdd(): Promise<void> {
  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  // Load humanTitle from config for prompt generation
  const humanTitle: string = raw.humanTitle ?? 'Boss';

  console.log('Add a new agent\n');

  // --- Identity ---
  console.log('── Identity ──');
  const id = await ask('Assistant ID (lowercase, e.g. hr)');
  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    console.error('ID must be lowercase alphanumeric (start with letter).');
    process.exit(1);
  }
  if (raw.teams[id]) {
    console.error(`Assistant "${id}" already exists.`);
    process.exit(1);
  }

  const name = await ask('Display name (e.g. Backend)', id.charAt(0).toUpperCase() + id.slice(1));
  const isLeader = await confirm('Is this the leader (responds to all messages)?', false);

  // --- Character ---
  console.log('\n── Character ──');

  // MBTI
  const mbtiNames = Object.keys(MBTI_PRESETS);
  const mbtiChoice = await choose('MBTI:', mbtiNames, 0);
  let mbti = MBTI_PRESETS[mbtiChoice];
  if (!mbti) {
    mbti = await ask('MBTI (e.g. ISFJ — Diligent, caring, executor)');
  }

  // Speech style
  const speechNames = Object.keys(SPEECH_PRESETS);
  const speechChoice = await choose('Speech style:', speechNames, 0);
  let speechStyle = SPEECH_PRESETS[speechChoice];
  if (!speechStyle) {
    console.log('Enter speech style line by line (empty line to finish):');
    const lines: string[] = [];
    let line = await ask('  ');
    while (line) {
      lines.push(`  - ${line}`);
      line = await ask('  ');
    }
    speechStyle = lines.join('\n');
  }

  // Traits
  console.log('Personality traits (with behavior examples, comma-separated):');
  console.log('  e.g. "Systematic — structures all requirements, Cautious — verifies when unsure"');
  const traitsStr = await ask('  Traits', '');
  const traits = traitsStr
    ? traitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Habits
  console.log('Habits (comma-separated):');
  console.log('  e.g. "Reports in conclusion→evidence→next-steps order, Ends delegations with clear directives"');
  const habitsStr = await ask('  Habits', '');
  const habits = habitsStr
    ? habitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // --- Role ---
  console.log('\n── Role ──');
  const role = await ask('Core role (1-2 sentences)');

  console.log('Scope (comma-separated):');
  const scopeStr = await ask('  Scope', '');
  const scope = scopeStr
    ? scopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  console.log('Not in scope (comma-separated):');
  const notScopeStr = await ask('  Not in scope', '');
  const notScope = notScopeStr
    ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const authorityIndependent = await ask('Independent decisions', '');
  const authorityNeedsApproval = await ask('Needs approval for', '');

  // Expertise
  console.log('Expertise (comma-separated):');
  const expertiseStr = await ask('  Expertise', '');
  const expertise = expertiseStr
    ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Custom rules
  console.log('Additional rules (comma-separated):');
  const rulesStr = await ask('  Rules', '');
  const rules = rulesStr
    ? rulesStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Agent teams
  const useTeams = await confirm('Enable agent team mode (parallel sub-agents)?', false);
  let teamRules: string[] = [];
  if (useTeams) {
    console.log('Team rules (comma-separated):');
    const teamRulesStr = await ask('  Team rules', '');
    teamRules = teamRulesStr
      ? teamRulesStr.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  }

  // --- Engine ---
  console.log('\n── Engine ──');
  const engine = await choose('Engine:', ['claude', 'codex', 'gemini'], 0);
  const model = await ask('Model', ENGINE_DEFAULTS[engine] ?? 'sonnet');
  const budgetStr = await ask('Max budget per invocation ($)', '10');
  const maxBudget = parseFloat(budgetStr) || 10;

  // --- Tokens ---
  console.log('\n── Tokens ──');
  const discordToken = await ask('Discord bot token');

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
  const gitEmail = await ask('Git author email', `${id}@users.noreply.github.com`);

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
    ...(useTeams ? { useTeams: true } : {}),
    ...(teamRules.length > 0 ? { teamRules } : {}),
    ...(channels.length > 0 ? { channels } : {}),
    git: { name: gitName, email: gitEmail },
    permissions,
  };
  fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');

  // Append tokens to .env
  const envPath = path.join(ws, '.env');
  fs.appendFileSync(envPath, `${id.toUpperCase()}_DISCORD_TOKEN=${discordToken}\n`);

  // Generate prompt file
  const promptPath = path.join(ws, 'prompts', `${id}.md`);
  if (!fs.existsSync(promptPath)) {
    fs.writeFileSync(promptPath, generatePrompt({
      name, mbti, speechStyle, traits, habits,
      role, scope, notScope,
      authorityIndependent, authorityNeedsApproval,
      expertise, rules, isLeader,
      humanTitle,
    }));
  }

  console.log(`\nAgent "${name}" (${id}) added successfully.`);
  console.log(`  Config:  teams.json`);
  console.log(`  Prompt:  prompts/${id}.md  (editable)`);
  console.log(`  Tokens:  .env`);
  console.log(`\nRun \`mococo start\` to launch.`);
}
