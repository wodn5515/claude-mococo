import fs from 'node:fs';
import path from 'node:path';
import { formatConversation } from '../teams/context.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

export async function buildTeamPrompt(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
): Promise<string> {
  const ws = config.workspacePath;
  const template = fs.readFileSync(path.resolve(ws, team.prompt), 'utf-8');
  const conversationText = formatConversation(invocation.conversation);

  // Dynamic Team Directory — auto-generated from teams.json
  const teamDirectory = Object.values(config.teams)
    .filter(t => t.id !== team.id)
    .map(t => {
      const engineTag = t.engine !== 'claude' ? ` [${t.engine}]` : '';
      const mention = t.discordUserId ? ` → tag with <@${t.discordUserId}>` : '';
      return `- @${t.name}${engineTag}${mention}`;
    })
    .join('\n');

  // Load repo-specific rules if the conversation mentions a repo
  let repoRules = '';
  const repoMatch = invocation.message.content.match(/repos\/(\S+)/);
  if (repoMatch) {
    const repoRulesPath = path.resolve(ws, `prompts/repo-specific/${repoMatch[1]}.md`);
    if (fs.existsSync(repoRulesPath)) {
      repoRules = `\n\n## Repository-Specific Rules\n${fs.readFileSync(repoRulesPath, 'utf-8')}`;
    }
  }

  // List available repos
  let repos: string[] = [];
  try {
    repos = fs.readdirSync(path.resolve(ws, 'repos')).filter(f => f !== '.gitkeep');
  } catch {
    // repos dir may not exist
  }
  const repoList = repos.length > 0
    ? repos.map(r => `- repos/${r}`).join('\n')
    : '(no repos linked yet)';

  return `${template}

## Team Directory
These are the teams you can tag. Mention @TeamName to hand off work:
${teamDirectory}

## Discord Conversation (recent)
\`\`\`
${conversationText}
\`\`\`

## Discord Mentions
When tagging someone, **always put \`<@ID>\` at the very beginning of your message.**
- **Replying to human's question:** Do NOT tag. They already know you're talking to them.
- **Reporting to human proactively** (status update, task done, asking a question): Tag with \`<@ID>\`.
- **Handing off to another bot or addressing a bot:** ALWAYS tag with \`<@ID>\`.
Example: \`<@123456> 회장님, 작업 완료했습니다.\`
${config.humanDiscordId ? `- Human (회장님): <@${config.humanDiscordId}>` : ''}${invocation.message.discordId && invocation.message.discordId !== config.humanDiscordId ? `\n- ${invocation.message.teamName}: <@${invocation.message.discordId}>` : ''}

## The Message That Triggered You
From: ${invocation.message.teamId === 'human' ? `Human (<@${invocation.message.discordId ?? ''}>)` : invocation.message.teamName}
Content: ${invocation.message.content}

## Available Repositories
${repoList}
${repoRules}

${team.isLeader ? `## Task Channels
- Create: \`[task:create name @Bot1 @Bot2]\`
- Archive: \`[task:done name]\`
` : ''}
## Your Identity
You are: ${team.name} (engine: ${team.engine}, model: ${team.model})
${team.useTeams ? `
## Agent Teams
You have agent team capabilities enabled. For complex tasks that involve multiple files, parallel work, or multi-step operations, you SHOULD use the team/swarm tools to spawn sub-agents and coordinate work in parallel. This improves speed and quality. For simple single-file tasks, work directly without spawning a team.
${team.teamRules?.length ? `\n### Team Rules\n${team.teamRules.map(r => `- ${r}`).join('\n')}` : ''}` : ''}
`;
}
