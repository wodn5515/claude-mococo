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

const EDIT_FIELDS = [
  'name        — Display name',
  'character   — MBTI, speech style, personality, habits',
  'role        — Scope, authority, expertise',
  'engine      — Engine and model',
  'budget      — Max budget',
  'channels    — Channel restrictions',
  'permissions — Permission preset',
  'git         — Git author identity',
  'all         — Edit everything',
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

  // Load humanTitle from config for prompt generation
  const humanTitle: string = raw.humanTitle ?? 'Boss';

  if (!team) {
    console.error(`Assistant "${id}" not found.`);
    const ids = Object.keys(raw.teams);
    if (ids.length > 0) {
      console.error(`Available: ${ids.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`Editing assistant "${team.name}" (${id})\n`);

  const fieldChoice = await choose('What to edit:', EDIT_FIELDS, 7);
  const field = fieldChoice.split(' ')[0];

  const editAll = field === 'all';

  // Name
  if (editAll || field === 'name') {
    team.name = await ask('Display name', team.name);
  }

  // Character & Role → regenerate prompt
  let regeneratePrompt = false;
  let mbti = '';
  let speechStyle = '';
  let traits: string[] = [];
  let habits: string[] = [];
  let role = '';
  let scope: string[] = [];
  let notScope: string[] = [];
  let authorityIndependent = '';
  let authorityNeedsApproval = '';
  let expertise: string[] = [];
  let rules: string[] = [];
  let isLeader = team.isLeader ?? false;

  if (editAll || field === 'character' || field === 'role') {
    if (editAll || field === 'character') {
      console.log('\n── Character ──');

      const mbtiNames = Object.keys(MBTI_PRESETS);
      const mbtiChoice = await choose('MBTI:', mbtiNames, 0);
      mbti = MBTI_PRESETS[mbtiChoice];
      if (!mbti) {
        mbti = await ask('MBTI (e.g. ISFJ — Diligent, caring, executor)');
      }

      const speechNames = Object.keys(SPEECH_PRESETS);
      const speechChoice = await choose('Speech style:', speechNames, 0);
      speechStyle = SPEECH_PRESETS[speechChoice];
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

      console.log('Personality traits (with behavior examples, comma-separated):');
      const traitsStr = await ask('  Traits', '');
      traits = traitsStr ? traitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('Habits (comma-separated):');
      const habitsStr = await ask('  Habits', '');
      habits = habitsStr ? habitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    if (editAll || field === 'role') {
      console.log('\n── Role ──');
      role = await ask('Core role (1-2 sentences)', '');

      console.log('Scope (comma-separated):');
      const scopeStr = await ask('  Scope', '');
      scope = scopeStr ? scopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('Not in scope (comma-separated):');
      const notScopeStr = await ask('  Not in scope', '');
      notScope = notScopeStr ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      authorityIndependent = await ask('Independent decisions', '');
      authorityNeedsApproval = await ask('Needs approval for', '');

      console.log('Expertise (comma-separated):');
      const expertiseStr = await ask('  Expertise', '');
      expertise = expertiseStr ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('Additional rules (comma-separated):');
      const rulesStr = await ask('  Rules', '');
      rules = rulesStr ? rulesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      isLeader = await confirm('Is this the leader?', team.isLeader ?? false);
      if (isLeader) {
        team.isLeader = true;
      } else {
        delete team.isLeader;
      }
    }

    regeneratePrompt = await confirm('Regenerate persona file? (overwrites existing)', true);
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

  // Channels
  if (editAll || field === 'channels') {
    const current = (team.channels ?? []).join(', ');
    console.log(`Current channels: ${current || '(all channels)'}`);
    console.log('Channel IDs (comma-separated, empty = all channels):');
    const channelsStr = await ask('  Channels', current);
    const channels = channelsStr
      ? channelsStr.split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];
    if (channels.length > 0) {
      team.channels = channels;
    } else {
      delete team.channels;
    }
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
    git.email = await ask('Git author email', git.email ?? `${id}@users.noreply.github.com`);
    team.git = git;
  }

  closeRL();

  // Save teams.json
  raw.teams[id] = team;
  fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');

  // Regenerate prompt if requested
  if (regeneratePrompt && (role || mbti)) {
    const promptPath = path.join(ws, 'prompts', `${id}.md`);
    fs.writeFileSync(promptPath, generatePrompt({
      name: team.name,
      mbti: mbti || 'MBTI — (edit manually)',
      speechStyle: speechStyle || '  - (edit manually)',
      traits, habits,
      role: role || '(edit manually)',
      scope, notScope,
      authorityIndependent, authorityNeedsApproval,
      expertise, rules,
      isLeader,
      humanTitle,
    }));
    console.log(`  Persona regenerated: prompts/${id}.md`);
  }

  console.log(`\nAgent "${team.name}" (${id}) updated successfully.`);
}
