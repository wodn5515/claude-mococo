import fs from 'node:fs';
import path from 'node:path';
import { ask, confirm, choose, closeRL } from '../readline-utils.js';
import { generatePrompt } from '../prompt-template.js';
import { requireWorkspace } from '../workspace.js';
import {
  t, isLangExplicit, setLang,
  getMbtiPresets, getSpeechPresets, getPermissionPresets, getEditFields,
} from '../i18n.js';

const ENGINE_DEFAULTS: Record<string, string> = {
  claude: 'sonnet',
  codex: 'o3',
  gemini: 'gemini-2.5-pro',
};

export async function runEdit(id: string): Promise<void> {
  if (!id) {
    console.error(t('edit.usage'));
    process.exit(1);
  }

  // Language selection if --lang not specified
  if (!isLangExplicit()) {
    const useKo = await confirm(t('lang.prompt'), false);
    if (useKo) setLang('ko', true);
  }

  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));
  const team = raw.teams[id];

  // Load humanTitle from config for prompt generation
  const humanTitle: string = raw.humanTitle ?? 'Boss';

  if (!team) {
    console.error(`"${id}" ${t('edit.notFound')}`);
    const ids = Object.keys(raw.teams);
    if (ids.length > 0) {
      console.error(`${t('edit.available')} ${ids.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`${t('edit.title')} "${team.name}" (${id})\n`);

  const EDIT_FIELDS = getEditFields();
  const fieldChoice = await choose(t('edit.what'), EDIT_FIELDS, 7);
  const field = fieldChoice.split(' ')[0];

  const editAll = field === 'all';

  // Name
  if (editAll || field === 'name') {
    team.name = await ask(t('add.askName'), team.name);
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
      console.log(t('add.character'));

      const MBTI_PRESETS = getMbtiPresets();
      const mbtiNames = Object.keys(MBTI_PRESETS);
      const mbtiChoice = await choose(t('shared.mbti'), mbtiNames, 0);
      mbti = MBTI_PRESETS[mbtiChoice];
      if (!mbti) {
        mbti = await ask(t('add.askMbtiCustom'));
      }

      const SPEECH_PRESETS = getSpeechPresets();
      const speechNames = Object.keys(SPEECH_PRESETS);
      const speechChoice = await choose(t('shared.speech'), speechNames, 0);
      speechStyle = SPEECH_PRESETS[speechChoice];
      if (!speechStyle) {
        console.log(t('add.speechCustom'));
        const lines: string[] = [];
        let line = await ask('  ');
        while (line) {
          lines.push(`  - ${line}`);
          line = await ask('  ');
        }
        speechStyle = lines.join('\n');
      }

      console.log(t('add.askTraits'));
      const traitsStr = await ask(t('shared.traits'), '');
      traits = traitsStr ? traitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log(t('add.askHabits'));
      const habitsStr = await ask(t('shared.habits'), '');
      habits = habitsStr ? habitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    if (editAll || field === 'role') {
      console.log(t('add.role'));
      role = await ask(t('add.askRole'), '');

      console.log(t('add.askScope'));
      const scopeStr = await ask(t('shared.scope'), '');
      scope = scopeStr ? scopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log(t('add.askNotScope'));
      const notScopeStr = await ask(t('shared.notScope'), '');
      notScope = notScopeStr ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      authorityIndependent = await ask(t('add.askAuthIndep'), '');
      authorityNeedsApproval = await ask(t('add.askAuthApproval'), '');

      console.log(t('add.askExpertise'));
      const expertiseStr = await ask(t('shared.expertise'), '');
      expertise = expertiseStr ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log(t('add.askRules'));
      const rulesStr = await ask(t('shared.rules'), '');
      rules = rulesStr ? rulesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      isLeader = await confirm(t('shared.isLeader'), team.isLeader ?? false);
      if (isLeader) {
        team.isLeader = true;
      } else {
        delete team.isLeader;
      }
    }

    regeneratePrompt = await confirm(t('edit.regen'), true);
  }

  // Engine
  if (editAll || field === 'engine') {
    const engine = await choose('Engine:', ['claude', 'codex', 'gemini'],
      ['claude', 'codex', 'gemini'].indexOf(team.engine));
    team.engine = engine;
    team.model = await ask(t('add.askModel'), team.model ?? ENGINE_DEFAULTS[engine]);
  }

  // Budget
  if (editAll || field === 'budget') {
    const budgetStr = await ask(t('add.askBudget'), String(team.maxBudget ?? 10));
    team.maxBudget = parseFloat(budgetStr) || 10;
  }

  // Channels
  if (editAll || field === 'channels') {
    const current = (team.channels ?? []).join(', ');
    console.log(`${t('shared.currentCh')} ${current || t('shared.allCh')}`);
    console.log(t('shared.chGuide'));
    const channelsStr = await ask(t('shared.channels'), current);
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
    const PERMISSION_PRESETS = getPermissionPresets();
    const presetNames = Object.keys(PERMISSION_PRESETS);
    const presetChoice = await choose(t('shared.permPreset'), presetNames, 1);
    team.permissions = PERMISSION_PRESETS[presetChoice] ?? {};
  }

  // Git identity
  if (editAll || field === 'git') {
    const git = team.git ?? {};
    git.name = await ask(t('add.askGitName'), git.name ?? `${team.name} (mococo)`);
    git.email = await ask(t('add.askGitEmail'), git.email ?? `${id}@users.noreply.github.com`);
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
    console.log(`${t('edit.regenDone')} prompts/${id}.md`);
  }

  console.log(`\n"${team.name}" (${id}) ${t('edit.done')}`);
}
