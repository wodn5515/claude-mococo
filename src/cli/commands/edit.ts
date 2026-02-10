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

const EDIT_FIELDS = [
  'name        — Display name',
  'character   — MBTI, 말투, 성격, 습관',
  'role        — 담당/비담당/권한',
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
        mbti = await ask('MBTI (e.g. ISFJ — 성실, 배려, 실행력)');
      }

      const speechNames = Object.keys(SPEECH_PRESETS);
      const speechChoice = await choose('말투:', speechNames, 0);
      speechStyle = SPEECH_PRESETS[speechChoice];
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

      console.log('성격 특성 (행동 예시 포함, comma-separated):');
      const traitsStr = await ask('  성격', '');
      traits = traitsStr ? traitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('습관 (comma-separated):');
      const habitsStr = await ask('  습관', '');
      habits = habitsStr ? habitsStr.split(',').map(s => s.trim()).filter(Boolean) : [];
    }

    if (editAll || field === 'role') {
      console.log('\n── Role ──');
      role = await ask('핵심 역할 (1-2문장)', '');

      console.log('담당 범위 (comma-separated):');
      const scopeStr = await ask('  담당', '');
      scope = scopeStr ? scopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('담당 아닌 것 (comma-separated):');
      const notScopeStr = await ask('  비담당', '');
      notScope = notScopeStr ? notScopeStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      authorityIndependent = await ask('독립 결정 가능한 것', '');
      authorityNeedsApproval = await ask('승인 필요한 것', '');

      console.log('전문 분야 (comma-separated):');
      const expertiseStr = await ask('  Expertise', '');
      expertise = expertiseStr ? expertiseStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      console.log('추가 규칙 (comma-separated):');
      const rulesStr = await ask('  Rules', '');
      rules = rulesStr ? rulesStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      isLeader = await confirm('Is this the leader?', team.isLeader ?? false);
      if (isLeader) {
        team.isLeader = true;
      } else {
        delete team.isLeader;
      }
    }

    regeneratePrompt = await confirm('페르소나 파일 재생성? (기존 파일 덮어쓰기)', true);
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
    git.email = await ask('Git author email', git.email ?? `mococo-${id}@users.noreply.github.com`);
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
      mbti: mbti || 'MBTI — (직접 작성)',
      speechStyle: speechStyle || '  - (직접 작성)',
      traits, habits,
      role: role || '(직접 작성)',
      scope, notScope,
      authorityIndependent, authorityNeedsApproval,
      expertise, rules,
      isLeader,
    }));
    console.log(`  페르소나 재생성: prompts/${id}.md`);
  }

  console.log(`\n모코코 "${team.name}" (${id}) 수정 완료.`);
}
