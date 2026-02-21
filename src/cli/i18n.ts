export type Lang = 'en' | 'ko';

let currentLang: Lang = 'en';
let langExplicit = false;

export function setLang(lang: Lang, explicit = false): void {
  currentLang = lang;
  if (explicit) langExplicit = true;
}

export function getLang(): Lang {
  return currentLang;
}

export function isLangExplicit(): boolean {
  return langExplicit;
}

/* ── Localised presets (shared by add & edit) ── */

export function getMbtiPresets(): Record<string, string> {
  if (currentLang === 'ko') {
    return {
      'ENTJ — 전략가, 결단력, 큰 그림을 보는 리더': 'ENTJ — 전략가, 결단력, 큰 그림을 보는 리더',
      'ISTJ — 규칙 준수, 체계적, 정확성 중심': 'ISTJ — 규칙 준수, 체계적, 정확성 중심',
      'ENFJ — 사람 중심, 공감 능력, 팀 조화': 'ENFJ — 사람 중심, 공감 능력, 팀 조화',
      'INTP — 분석적, 논리적, 깊이 파는 탐구자': 'INTP — 분석적, 논리적, 깊이 파는 탐구자',
      '직접 입력': '',
    };
  }
  return {
    'ENTJ — Strategist, decisive, big-picture leader': 'ENTJ — Strategist, decisive, big-picture leader',
    'ISTJ — Rule-follower, systematic, accuracy-focused': 'ISTJ — Rule-follower, systematic, accuracy-focused',
    'ENFJ — People-oriented, empathetic, team harmony': 'ENFJ — People-oriented, empathetic, team harmony',
    'INTP — Analytical, logical, deep explorer': 'INTP — Analytical, logical, deep explorer',
    'Custom': '',
  };
}

export function getSpeechPresets(): Record<string, string> {
  if (currentLang === 'ko') {
    return {
      '모두에게 존댓말': [
        '  - 사람에게: 정중하고 격식 있는 존댓말',
        '  - 리더에게: 정중하고 격식 있는 존댓말',
        '  - 다른 에이전트에게: 예의 바르고 전문적인 말투',
      ].join('\n'),
      '사람에게 존댓말 + 동료에게 반말': [
        '  - 사람에게: 엄격하게 정중한 존댓말',
        '  - 다른 에이전트에게: 편한 반말',
      ].join('\n'),
      '직접 입력': '',
    };
  }
  return {
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
}

export function getPermissionPresets(): Record<string, { allow?: string[]; deny?: string[] }> {
  if (currentLang === 'ko') {
    return {
      '전체 — 푸시, PR 생성 가능': {
        allow: ['git push', 'gh pr create'],
        deny: ['gh pr merge'],
      },
      '개발자 — 파일 수정 가능, 푸시 불가': {
        deny: ['git push', 'gh pr'],
      },
      '읽기 전용 — 수정 불가, 푸시 불가': {
        deny: ['git push', 'gh pr', 'Edit', 'Write'],
      },
    };
  }
  return {
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
}

export function getEditFields(): string[] {
  if (currentLang === 'ko') {
    return [
      'name        — 표시 이름',
      'character   — MBTI, 말투, 성격, 습관',
      'role        — 범위, 권한, 전문성',
      'engine      — 엔진 및 모델',
      'budget      — 최대 예산',
      'channels    — 채널 제한',
      'permissions — 권한 프리셋',
      'git         — Git 작성자 정보',
      'all         — 전부 편집',
    ];
  }
  return [
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
}

/* ── Message dictionary ── */

const msg: Record<string, Record<Lang, string>> = {
  // language selection (shown before language is set, so bilingual)
  'lang.prompt': { en: 'Use Korean? (한국어로 진행할까요?)', ko: '한국어로 진행할까요?' },

  // init
  'init.existing': { en: 'Existing workspace detected. Updating settings...\n', ko: '기존 워크스페이스 감지됨. 설정을 업데이트합니다...\n' },
  'init.fresh': { en: 'Initializing workspace...\n', ko: '워크스페이스를 초기화합니다...\n' },
  'init.askChannel': { en: 'Discord work channel ID (leave empty for all channels)', ko: 'Discord 작업 채널 ID (전체 채널이면 비워두세요)' },
  'init.askHumanId': { en: 'Your Discord user ID (right-click your name → Copy User ID)', ko: 'Discord 사용자 ID (이름 우클릭 → 사용자 ID 복사)' },
  'init.hooksWarn': { en: 'Warning: hooks/ not found in package. You may need to copy them manually.', ko: '경고: hooks/를 패키지에서 찾을 수 없습니다. 수동 복사가 필요할 수 있습니다.' },
  'init.updated': { en: '\nWorkspace updated.', ko: '\n워크스페이스가 업데이트되었습니다.' },
  'init.updatedTeams': { en: '  teams.json   — settings updated (assistants preserved)', ko: '  teams.json   — 설정 업데이트 (어시스턴트 유지)' },
  'init.updatedEnv': { en: '  .env         — channel/port updated (tokens preserved)', ko: '  .env         — 채널/포트 업데이트 (토큰 유지)' },
  'init.updatedHooks': { en: '  hooks/       — refreshed from package', ko: '  hooks/       — 패키지에서 갱신' },
  'init.created': { en: '\nWorkspace created:', ko: '\n워크스페이스가 생성되었습니다:' },
  'init.createdTeams': { en: '  teams.json   — assistant configuration', ko: '  teams.json   — 어시스턴트 설정' },
  'init.createdEnv': { en: '  .env         — tokens and settings', ko: '  .env         — 토큰 및 설정' },
  'init.createdPrompts': { en: '  prompts/     — personality files', ko: '  prompts/     — 성격 파일' },
  'init.createdRepos': { en: '  repos/       — linked repositories', ko: '  repos/       — 연결된 저장소' },
  'init.createdHooks': { en: '  hooks/       — Claude Code hooks', ko: '  hooks/       — Claude Code 훅' },
  'init.next': { en: '\nNext: run `mococo add` to add your first assistant.', ko: '\n다음: `mococo add`를 실행하여 첫 어시스턴트를 추가하세요.' },

  // add
  'add.title': { en: 'Add a new agent\n', ko: '새 에이전트 추가\n' },
  'add.identity': { en: '── Identity ──', ko: '── 신원 ──' },
  'add.askId': { en: 'Assistant ID (lowercase, e.g. hr)', ko: '어시스턴트 ID (소문자, 예: hr)' },
  'add.badId': { en: 'ID must be lowercase alphanumeric (start with letter).', ko: 'ID는 소문자 영숫자여야 합니다 (문자로 시작).' },
  'add.dupId': { en: 'already exists.', ko: '이미 존재합니다.' },
  'add.askName': { en: 'Display name (e.g. Backend)', ko: '표시 이름 (예: Backend)' },
  'add.askLeader': { en: 'Is this the leader (responds to all messages)?', ko: '리더입니까 (모든 메시지에 응답)?' },
  'add.character': { en: '\n── Character ──', ko: '\n── 캐릭터 ──' },
  'add.askMbtiCustom': { en: 'MBTI (e.g. ISFJ — Diligent, caring, executor)', ko: 'MBTI (예: ISFJ — 성실, 배려, 실행가)' },
  'add.speechCustom': { en: 'Enter speech style line by line (empty line to finish):', ko: '말투를 줄 단위로 입력하세요 (빈 줄로 종료):' },
  'add.askTraits': { en: 'Personality traits (with behavior examples, comma-separated):', ko: '성격 특성 (행동 예시 포함, 쉼표 구분):' },
  'add.traitsEx': { en: '  e.g. "Systematic — structures all requirements, Cautious — verifies when unsure"', ko: '  예: "체계적 — 모든 요구사항을 구조화, 신중함 — 불확실하면 검증"' },
  'add.askHabits': { en: 'Habits (comma-separated):', ko: '습관 (쉼표 구분):' },
  'add.habitsEx': { en: '  e.g. "Reports in conclusion→evidence→next-steps order"', ko: '  예: "결론→근거→다음 단계 순서로 보고"' },
  'add.role': { en: '\n── Role ──', ko: '\n── 역할 ──' },
  'add.askRole': { en: 'Core role (1-2 sentences)', ko: '핵심 역할 (1-2문장)' },
  'add.askScope': { en: 'Scope (comma-separated):', ko: '담당 범위 (쉼표 구분):' },
  'add.askNotScope': { en: 'Not in scope (comma-separated):', ko: '담당 아님 (쉼표 구분):' },
  'add.askAuthIndep': { en: 'Independent decisions', ko: '독립 결정 권한' },
  'add.askAuthApproval': { en: 'Needs approval for', ko: '승인 필요 사항' },
  'add.askExpertise': { en: 'Expertise (comma-separated):', ko: '전문 분야 (쉼표 구분):' },
  'add.askRules': { en: 'Additional rules (comma-separated):', ko: '추가 규칙 (쉼표 구분):' },
  'add.askTeams': { en: 'Enable agent team mode (parallel sub-agents)?', ko: '에이전트 팀 모드 활성화 (병렬 서브 에이전트)?' },
  'add.askTeamRules': { en: 'Team rules (comma-separated):', ko: '팀 규칙 (쉼표 구분):' },
  'add.engine': { en: '\n── Engine ──', ko: '\n── 엔진 ──' },
  'add.askModel': { en: 'Model', ko: '모델' },
  'add.askBudget': { en: 'Max budget per invocation ($)', ko: '호출당 최대 예산 ($)' },
  'add.tokens': { en: '\n── Tokens ──', ko: '\n── 토큰 ──' },
  'add.askToken': { en: 'Discord bot token', ko: 'Discord 봇 토큰' },
  'add.channels': { en: '\n── Channels ──', ko: '\n── 채널 ──' },
  'add.askChannels': { en: 'Channel IDs this bot responds in (comma-separated, empty = all channels):', ko: '봇이 응답할 채널 ID (쉼표 구분, 비우면 전체 채널):' },
  'add.permissions': { en: '\n── Permissions ──', ko: '\n── 권한 ──' },
  'add.git': { en: '\n── Git identity ──', ko: '\n── Git 신원 ──' },
  'add.askGitName': { en: 'Git author name', ko: 'Git 작성자 이름' },
  'add.askGitEmail': { en: 'Git author email', ko: 'Git 작성자 이메일' },
  'add.done': { en: 'added successfully.', ko: '추가 완료.' },
  'add.configLine': { en: '  Config:  teams.json', ko: '  설정:    teams.json' },
  'add.promptLine': { en: '  Prompt:', ko: '  프롬프트:' },
  'add.tokenLine': { en: '  Tokens:  .env', ko: '  토큰:    .env' },
  'add.launch': { en: '\nRun `mococo start` to launch.', ko: '\n`mococo start`로 실행하세요.' },

  // edit
  'edit.usage': { en: 'Usage: mococo edit <assistant-id>', ko: '사용법: mococo edit <어시스턴트-ID>' },
  'edit.notFound': { en: 'not found.', ko: '을(를) 찾을 수 없습니다.' },
  'edit.available': { en: 'Available:', ko: '사용 가능:' },
  'edit.title': { en: 'Editing assistant', ko: '어시스턴트 편집 중' },
  'edit.what': { en: 'What to edit:', ko: '편집할 항목:' },
  'edit.regen': { en: 'Regenerate persona file? (overwrites existing)', ko: '성격 파일을 재생성하시겠습니까? (기존 파일 덮어쓰기)' },
  'edit.regenDone': { en: '  Persona regenerated:', ko: '  성격 파일 재생성:' },
  'edit.done': { en: 'updated successfully.', ko: '업데이트 완료.' },

  // shared prompts used by both add & edit
  'shared.mbti': { en: 'MBTI:', ko: 'MBTI:' },
  'shared.speech': { en: 'Speech style:', ko: '말투:' },
  'shared.traits': { en: '  Traits', ko: '  특성' },
  'shared.habits': { en: '  Habits', ko: '  습관' },
  'shared.scope': { en: '  Scope', ko: '  범위' },
  'shared.notScope': { en: '  Not in scope', ko: '  담당 아님' },
  'shared.expertise': { en: '  Expertise', ko: '  전문 분야' },
  'shared.rules': { en: '  Rules', ko: '  규칙' },
  'shared.teamRules': { en: '  Team rules', ko: '  팀 규칙' },
  'shared.channels': { en: '  Channels', ko: '  채널' },
  'shared.permPreset': { en: 'Permission preset:', ko: '권한 프리셋:' },
  'shared.currentCh': { en: 'Current channels:', ko: '현재 채널:' },
  'shared.allCh': { en: '(all channels)', ko: '(전체 채널)' },
  'shared.chGuide': { en: 'Channel IDs (comma-separated, empty = all channels):', ko: '채널 ID (쉼표 구분, 비우면 전체 채널):' },
  'shared.isLeader': { en: 'Is this the leader?', ko: '리더입니까?' },
};

export function t(key: string): string {
  const entry = msg[key];
  if (!entry) return key;
  return entry[currentLang] ?? entry.en ?? key;
}

/**
 * Parse --lang flag from argv and remove it from the array.
 * Returns the remaining args.
 */
export function parseLangFlag(argv: string[]): string[] {
  const args = [...argv];
  const idx = args.indexOf('--lang');
  if (idx !== -1 && args[idx + 1]) {
    const val = args[idx + 1];
    if (val === 'ko' || val === 'en') {
      setLang(val, true);
    }
    args.splice(idx, 2);
  }
  return args;
}
