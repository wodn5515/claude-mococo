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

const EDIT_FIELDS = [
  'name       — Display name',
  'role       — Role and prompt (regenerate)',
  'engine     — Engine and model',
  'budget     — Max budget',
  'permissions — Permission preset',
  'git        — Git author identity',
  'all        — Edit everything',
];

export async function runEdit(id: string): Promise<void> {
  if (!id) {
    console.error('Usage: mococo edit <assistant-id>');
    process.exit(1);
  }

  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));
  const team = raw.teams[id];

  if (!team) {
    console.error(`Assistant "${id}" not found.`);
    const ids = Object.keys(raw.teams);
    if (ids.length > 0) {
      console.error(`Available: ${ids.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`Editing assistant "${team.name}" (${id})\n`);

  const fieldChoice = await choose('What to edit:', EDIT_FIELDS, 6);
  const field = fieldChoice.split(' ')[0];

  const editAll = field === 'all';

  // Name
  if (editAll || field === 'name') {
    team.name = await ask('Display name', team.name);
  }

  // Role & prompt
  let regeneratePrompt = false;
  let role = '';
  let personality = '';
  let expertise: string[] = [];
  let rules: string[] = [];
  let isLeader = team.isLeader ?? false;

  if (editAll || field === 'role') {
    role = await ask('Role description', '');
    personality = await ask('Personality description', '');

    console.log('Expertise (comma-separated):');
    const expertiseStr = await ask('  Skills', '');
    expertise = expertiseStr ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    console.log('Custom rules (comma-separated):');
    const rulesStr = await ask('  Rules', '');
    rules = rulesStr ? rulesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    isLeader = await confirm('Is this the leader?', team.isLeader ?? false);
    if (isLeader) {
      team.isLeader = true;
    } else {
      delete team.isLeader;
    }

    regeneratePrompt = await confirm('Regenerate prompt file? (overwrites existing)', true);
  }

  // Engine
  if (editAll || field === 'engine') {
    const engine = await choose('Engine:', ['claude', 'codex', 'gemini'],
      ['claude', 'codex', 'gemini'].indexOf(team.engine));
    team.engine = engine;
    team.model = await ask('Model', team.model ?? ENGINE_DEFAULTS[engine]);
  }

  // Budget
  if (editAll || field === 'budget') {
    const budgetStr = await ask('Max budget per invocation ($)', String(team.maxBudget ?? 10));
    team.maxBudget = parseFloat(budgetStr) || 10;
  }

  // Permissions
  if (editAll || field === 'permissions') {
    const presetNames = Object.keys(PERMISSION_PRESETS);
    const presetChoice = await choose('Permission preset:', presetNames, 1);
    team.permissions = PERMISSION_PRESETS[presetChoice] ?? {};
  }

  // Git identity
  if (editAll || field === 'git') {
    const git = team.git ?? {};
    git.name = await ask('Git author name', git.name ?? `${team.name} (mococo)`);
    git.email = await ask('Git author email', git.email ?? `mococo-${id}@users.noreply.github.com`);
    team.git = git;
  }

  closeRL();

  // Save teams.json
  raw.teams[id] = team;
  fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');

  // Regenerate prompt if requested
  if (regeneratePrompt && role) {
    const promptPath = path.join(ws, 'prompts', `${id}.md`);
    fs.writeFileSync(promptPath, generatePrompt({
      name: team.name,
      role,
      personality: personality || 'Helpful and professional.',
      expertise,
      rules,
      isLeader,
    }));
    console.log(`  Prompt regenerated: prompts/${id}.md`);
  }

  console.log(`\nAssistant "${team.name}" (${id}) updated.`);
}
