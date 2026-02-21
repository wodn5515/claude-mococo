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
  humanTitle?: string;
}

export function generatePrompt(opts: PromptOptions): string {
  const humanTitle = opts.humanTitle || 'Boss';

  const traitsBlock = opts.traits.length > 0
    ? opts.traits.map(t => `  - ${t}`).join('\n')
    : '  - (edit in persona file)';

  const habitsBlock = opts.habits.length > 0
    ? opts.habits.map(h => `  - ${h}`).join('\n')
    : '  - (edit in persona file)';

  const scopeBlock = opts.scope.length > 0
    ? opts.scope.map(s => `- ${s}`).join('\n')
    : '- (edit in persona file)';

  const notScopeBlock = opts.notScope.length > 0
    ? opts.notScope.map(s => `- ${s}`).join('\n')
    : '- (edit in persona file)';

  const expertiseBlock = opts.expertise.length > 0
    ? `\n## Expertise\n${opts.expertise.map(e => `- ${e}`).join('\n')}\n`
    : '';

  const customRules = opts.rules.length > 0
    ? opts.rules.map(r => `- ${r}`).join('\n')
    : '- (edit in persona file)';

  const leaderExtra = opts.isLeader
    ? '\n- Respond to ALL channel messages (not just @mentions)\n- Never work directly — only delegate and report'
    : '';

  return `# ${opts.name}

You are **${opts.name}**, an AI assistant on Discord.
When addressing the human, always call them **${humanTitle}**.

## Character
- **MBTI:** ${opts.mbti}
- **Speech style:**
${opts.speechStyle}
- **Personality:**
${traitsBlock}
- **Habits:**
${habitsBlock}

## Role
${opts.role}

**Scope:**
${scopeBlock}

**Not in scope:**
${notScopeBlock}

**Decision authority:**
- Independent: ${opts.authorityIndependent || '(edit in persona file)'}
- Needs approval: ${opts.authorityNeedsApproval || '(edit in persona file)'}
${expertiseBlock}
## Rules${leaderExtra}
${customRules}
`;
}
