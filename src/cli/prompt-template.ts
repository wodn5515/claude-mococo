export interface PromptOptions {
  name: string;
  mbti: string;
  speechStyle: string;
  traits: string[];
  habits: string[];
  role: string;
  scope: string[];
  notScope: string[];
  authorityIndependent: string;
  authorityNeedsApproval: string;
  expertise: string[];
  rules: string[];
  isLeader: boolean;
}

export function generatePrompt(opts: PromptOptions): string {
  const traitsBlock = opts.traits.length > 0
    ? opts.traits.map(t => `  - ${t}`).join('\n')
    : '  - (페르소나 파일에서 직접 작성)';

  const habitsBlock = opts.habits.length > 0
    ? opts.habits.map(h => `  - ${h}`).join('\n')
    : '  - (페르소나 파일에서 직접 작성)';

  const scopeBlock = opts.scope.length > 0
    ? opts.scope.map(s => `- ${s}`).join('\n')
    : '- (페르소나 파일에서 직접 작성)';

  const notScopeBlock = opts.notScope.length > 0
    ? opts.notScope.map(s => `- ${s}`).join('\n')
    : '- (페르소나 파일에서 직접 작성)';

  const expertiseBlock = opts.expertise.length > 0
    ? `\n## Expertise\n${opts.expertise.map(e => `- ${e}`).join('\n')}\n`
    : '';

  const customRules = opts.rules.length > 0
    ? opts.rules.map(r => `- ${r}`).join('\n')
    : '- (페르소나 파일에서 직접 작성)';

  const leaderExtra = opts.isLeader
    ? '\n- 채널의 모든 메시지에 반응 (@멘션뿐 아니라 전부)\n- 직접 작업 절대 금지 — 오직 위임과 보고만'
    : '';

  return `# ${opts.name}

You are **${opts.name}**, an AI assistant on Discord.
When addressing the human, always call them **회장님**.

## Character
- **MBTI:** ${opts.mbti}
- **말투:**
${opts.speechStyle}
- **성격:**
${traitsBlock}
- **습관:**
${habitsBlock}

## Role
${opts.role}

**담당:**
${scopeBlock}

**담당 아님:**
${notScopeBlock}

**결정 권한:**
- 독립 결정: ${opts.authorityIndependent || '(페르소나 파일에서 직접 작성)'}
- 승인 필요: ${opts.authorityNeedsApproval || '(페르소나 파일에서 직접 작성)'}
${expertiseBlock}
## Rules${leaderExtra}
${customRules}
`;
}
