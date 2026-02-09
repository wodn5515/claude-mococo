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
      return `- @${t.name}${engineTag}`;
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
To tag someone in Discord, use \`<@ID>\`. Only tag when you need their attention (e.g. handing off work, asking a question, reporting results).
${invocation.message.discordId ? `- Human: <@${invocation.message.discordId}> (only tag when reporting or asking a question)` : ''}

## The Message That Triggered You
From: ${invocation.message.teamId === 'human' ? `Human (<@${invocation.message.discordId ?? ''}>)` : invocation.message.teamName}
Content: ${invocation.message.content}

## Available Repositories
${repoList}
${repoRules}

## Your Identity
You are: ${team.name} (engine: ${team.engine}, model: ${team.model})
`;
}
