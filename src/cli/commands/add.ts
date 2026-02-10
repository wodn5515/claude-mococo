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
  'ENTJ — 전략가, 결단력, 큰 그림': 'ENTJ — 전략가, 결단력, 큰 그림을 보는 리더',
  'ISTJ — 규칙 준수, 체계적, 정확성': 'ISTJ — 규칙 준수, 체계적, 정확성 중시',
  'ENFJ — 사람 중심, 공감, 조직 조화': 'ENFJ — 사람 중심 사고, 조직 조화, 공감 능력',
  'INTP — 분석적, 논리적, 탐구형': 'INTP — 분석적, 논리적, 깊이 있는 탐구형',
  'Custom': '',
};

const SPEECH_PRESETS: Record<string, string> = {
  '모두 존댓말': [
    '  - 회장님께: 존댓말. "회장님, ~입니다"',
    '  - 대장코코에게: 존댓말. "대장님, ~입니다"',
    '  - 다른 모코코에게: 존댓말. "{이름}코코님"',
  ].join('\n'),
  '회장님 존댓말 + 팀원 반말': [
    '  - 회장님께: 철저한 존댓말. "회장님, ~입니다", "~드리겠습니다"',
    '  - 다른 모코코들에게: 반말. "~해라", "~해봐", "~됐어?"',
  ].join('\n'),
  'Custom': '',
};

export async function runAdd(): Promise<void> {
  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  console.log('Add a new 모코코\n');

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

  const name = await ask('Display name (e.g. HR코코)', id.charAt(0).toUpperCase() + id.slice(1));
  const isLeader = await confirm('Is this the leader (responds to all messages)?', false);

  // --- Character ---
  console.log('\n── Character ──');

  // MBTI
  const mbtiNames = Object.keys(MBTI_PRESETS);
  const mbtiChoice = await choose('MBTI:', mbtiNames, 0);
  let mbti = MBTI_PRESETS[mbtiChoice];
  if (!mbti) {
    mbti = await ask('MBTI (e.g. ISFJ — 성실, 배려, 실행력)');
  }

  // Speech style
  const speechNames = Object.keys(SPEECH_PRESETS);
  const speechChoice = await choose('말투:', speechNames, 0);
  let speechStyle = SPEECH_PRESETS[speechChoice];
  if (!speechStyle) {
    console.log('말투를 줄별로 입력 (빈 줄로 종료):');
    const lines: string[] = [];
    let line = await ask('  ');
    while (line) {
      lines.push(`  - ${line}`);
      line = await ask('  ');
    }
    speechStyle = lines.join('\n');
  }

  // Traits
  console.log('성격 특성 (행동 예시 포함, comma-separated):');
  console.log('  예: "체계적 — 모든 요구사항을 구조화, 신중함 — 확실하지 않으면 확인"');
  const traitsStr = await ask('  성격', '');
  const traits = traitsStr
    ? traitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Habits
  console.log('습관 (comma-separated):');
  console.log('  예: "보고 시 결론→근거→다음단계 순서, 위임 시 명령조로 마무리"');
  const habitsStr = await ask('  습관', '');
  const habits = habitsStr
    ? habitsStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // --- Role ---
  console.log('\n── Role ──');
  const role = await ask('핵심 역할 (1-2문장)');

  console.log('담당 범위 (comma-separated):');
  const scopeStr = await ask('  담당', '');
  const scope = scopeStr
    ? scopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  console.log('담당 아닌 것 (comma-separated):');
  const notScopeStr = await ask('  비담당', '');
  const notScope = notScopeStr
    ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const authorityIndependent = await ask('독립 결정 가능한 것', '');
  const authorityNeedsApproval = await ask('승인 필요한 것', '');

  // Expertise
  console.log('전문 분야 (comma-separated):');
  const expertiseStr = await ask('  Expertise', '');
  const expertise = expertiseStr
    ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  // Custom rules
  console.log('추가 규칙 (comma-separated):');
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
    ...(useTeams ? { useTeams: true } : {}),
    ...(teamRules.length > 0 ? { teamRules } : {}),
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
    fs.writeFileSync(promptPath, generatePrompt({
      name, mbti, speechStyle, traits, habits,
      role, scope, notScope,
      authorityIndependent, authorityNeedsApproval,
      expertise, rules, isLeader,
    }));
  }

  console.log(`\n모코코 "${name}" (${id}) 추가 완료.`);
  console.log(`  Config:  teams.json`);
  console.log(`  Prompt:  prompts/${id}.md  (직접 수정 가능)`);
  console.log(`  Tokens:  .env`);
  console.log(`\nRun \`mococo start\` to launch.`);
}
