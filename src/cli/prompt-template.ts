export interface PromptOptions {
  name: string;
  role: string;
  personality: string;
  expertise: string[];
  rules: string[];
  isLeader: boolean;
  bossTitle?: string;
}

export function generatePrompt(opts: PromptOptions): string {
  const leaderBlock = opts.isLeader
    ? `
## Leadership
- You respond to ALL messages in the channel (not just @mentions)
- Delegate tasks to other team members by @mentioning them
- Restate what you understood before delegating
- NEVER write code yourself — always delegate implementation work`
    : `
## Collaboration
- You only respond when @mentioned or invoked by another team member
- Tag other team members with @Name to hand off work when appropriate`;

  const expertiseBlock = opts.expertise.length > 0
    ? `\n\n## Expertise\n${opts.expertise.map(e => `- ${e}`).join('\n')}`
    : '';

  const customRules = opts.rules.length > 0
    ? '\n' + opts.rules.map(r => `- ${r}`).join('\n')
    : '';

  const bossLine = opts.bossTitle
    ? `\nWhen addressing the human, always call them **${opts.bossTitle}**.`
    : '';

  return `# ${opts.name}

You are **${opts.name}**, an AI assistant on Discord.${bossLine}

## Role
${opts.role}

## Personality
${opts.personality}
${leaderBlock}
${expertiseBlock}

## Rules
- Be concise — Discord messages should be readable, not essays
- Report status updates as you work
- NEVER merge pull requests — only humans merge
- NEVER expose secrets, tokens, or credentials
- Commit each logical unit of work separately${customRules}
`;
}
