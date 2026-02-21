import fs from 'node:fs';
import path from 'node:path';
import { ask, confirm, choose, closeRL } from '../readline-utils.js';
import { generatePrompt } from '../prompt-template.js';
import { requireWorkspace } from '../workspace.js';
import {
  t, isLangExplicit, setLang,
  getMbtiPresets, getSpeechPresets, getPermissionPresets,
} from '../i18n.js';

const ENGINE_DEFAULTS: Record<string, string> = {
  claude: 'sonnet',
  codex: 'o3',
  gemini: 'gemini-2.5-pro',
};

const AVATAR_KEYS = ['robot', 'crown', 'brain', 'gear', 'palette', 'shield', 'eye', 'test', 'book'];

export async function runAdd(): Promise<void> {
  // Language selection if --lang not specified
  if (!isLangExplicit()) {
    const useKo = await confirm(t('lang.prompt'), false);
    if (useKo) setLang('ko', true);
  }

  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  // Load humanTitle from config for prompt generation
  const humanTitle: string = raw.humanTitle ?? 'Boss';

  console.log(t('add.title'));

  // --- Identity ---
  console.log(t('add.identity'));
  const id = await ask(t('add.askId'));
  if (!id || !/^[a-z][a-z0-9_-]*$/.test(id)) {
    console.error(t('add.badId'));
    process.exit(1);
  }
  if (raw.teams[id]) {
    console.error(`"${id}" ${t('add.dupId')}`);
    process.exit(1);
  }

  const name = await ask(t('add.askName'), id.charAt(0).toUpperCase() + id.slice(1));
  const isLeader = await confirm(t('add.askLeader'), false);

  // --- Character ---
  console.log(t('add.character'));

  // MBTI
  const MBTI_PRESETS = getMbtiPresets();
  const mbtiNames = Object.keys(MBTI_PRESETS);
  const mbtiChoice = await choose(t('shared.mbti'), mbtiNames, 0);
  let mbti = MBTI_PRESETS[mbtiChoice];
  if (!mbti) {
    mbti = await ask(t('add.askMbtiCustom'));
  }

  // Speech style
  const SPEECH_PRESETS = getSpeechPresets();
  const speechNames = Object.keys(SPEECH_PRESETS);
  const speechChoice = await choose(t('shared.speech'), speechNames, 0);
  let speechStyle = SPEECH_PRESETS[speechChoice];
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

  // Traits
  console.log(t('add.askTraits'));
  console.log(t('add.traitsEx'));
  const traitsStr = await ask(t('shared.traits'), '');
  const traits = traitsStr
    ? traitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Habits
  console.log(t('add.askHabits'));
  console.log(t('add.habitsEx'));
  const habitsStr = await ask(t('shared.habits'), '');
  const habits = habitsStr
    ? habitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // --- Role ---
  console.log(t('add.role'));
  const role = await ask(t('add.askRole'));

  console.log(t('add.askScope'));
  const scopeStr = await ask(t('shared.scope'), '');
  const scope = scopeStr
    ? scopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  console.log(t('add.askNotScope'));
  const notScopeStr = await ask(t('shared.notScope'), '');
  const notScope = notScopeStr
    ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const authorityIndependent = await ask(t('add.askAuthIndep'), '');
  const authorityNeedsApproval = await ask(t('add.askAuthApproval'), '');

  // Expertise
  console.log(t('add.askExpertise'));
  const expertiseStr = await ask(t('shared.expertise'), '');
  const expertise = expertiseStr
    ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Custom rules
  console.log(t('add.askRules'));
  const rulesStr = await ask(t('shared.rules'), '');
  const rules = rulesStr
    ? rulesStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Agent teams
  const useTeams = await confirm(t('add.askTeams'), false);
  let teamRules: string[] = [];
  if (useTeams) {
    console.log(t('add.askTeamRules'));
    const teamRulesStr = await ask(t('shared.teamRules'), '');
    teamRules = teamRulesStr
      ? teamRulesStr.split(',').map(s => s.trim()).filter(Boolean)
      : [];
  }

  // --- Engine ---
  console.log(t('add.engine'));
  const engine = await choose('Engine:', ['claude', 'codex', 'gemini'], 0);
  const model = await ask(t('add.askModel'), ENGINE_DEFAULTS[engine] ?? 'sonnet');
  const budgetStr = await ask(t('add.askBudget'), '10');
  const maxBudget = parseFloat(budgetStr) || 10;

  // --- Tokens ---
  console.log(t('add.tokens'));
  const discordToken = await ask(t('add.askToken'));

  // --- Channels ---
  console.log(t('add.channels'));
  console.log(t('add.askChannels'));
  const channelsStr = await ask(t('shared.channels'), '');
  const channels = channelsStr
    ? channelsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // --- Permissions ---
  console.log(t('add.permissions'));
  const PERMISSION_PRESETS = getPermissionPresets();
  const presetNames = Object.keys(PERMISSION_PRESETS);
  const presetChoice = await choose(t('shared.permPreset'), presetNames, 1);
  const permissions = PERMISSION_PRESETS[presetChoice] ?? {};

  // --- Git identity ---
  console.log(t('add.git'));
  const gitName = await ask(t('add.askGitName'), `${name} (mococo)`);
  const gitEmail = await ask(t('add.askGitEmail'), `${id}@users.noreply.github.com`);

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

  console.log(`\n"${name}" (${id}) ${t('add.done')}`);
  console.log(t('add.configLine'));
  console.log(`${t('add.promptLine')}  prompts/${id}.md  (editable)`);
  console.log(t('add.tokenLine'));
  console.log(t('add.launch'));
}
