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

  // Load persistent memory file
  const memoryDir = path.resolve(ws, '.mococo/memory');
  const memoryPath = path.resolve(memoryDir, `${team.id}.md`);
  let memory = '';
  try {
    memory = fs.readFileSync(memoryPath, 'utf-8').trim();
  } catch {
    // no memory file yet — that's fine
  }

  return `${template}

## Your Memory
Your persistent memory file. This survives across conversations — use it to track ongoing tasks, decisions, context, and anything you need to remember.
${memory ? `\n${memory}\n` : '\n(empty — nothing saved yet)\n'}
**You MUST update your memory at the end of every response** using the edit-memory command (see Discord Commands below). Review what you currently have, add new information from this conversation, and remove anything outdated. Keep it concise and organized.

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

## Discord Commands
You can manage Discord resources by embedding commands in your output. Commands are stripped before posting.
Syntax: \`[discord:action key=value key="quoted value"]\`

**Channels:**
- \`[discord:create-channel name=my-channel]\` — create a text channel
- \`[discord:create-channel name=my-channel category=Projects]\` — create under a category
- \`[discord:delete-channel name=my-channel]\`
- \`[discord:rename-channel name=old-name to=new-name]\`
- \`[discord:set-topic channel=my-channel topic="Channel description here"]\`
- \`[discord:move-channel channel=my-channel category=Archive]\`

**Threads:**
- \`[discord:create-thread name=my-thread]\` — in current channel
- \`[discord:create-thread name=my-thread channel=general]\` — in specific channel
- \`[discord:send-thread thread=my-thread message="Hello thread!" label=greeting]\`
- \`[discord:archive-thread thread=my-thread]\`
- \`[discord:lock-thread thread=my-thread]\`

**Categories:**
- \`[discord:create-category name=Projects]\`
- \`[discord:delete-category name=Projects]\`

**Messages:**
- \`[discord:pin-message id=123456789]\` or \`[discord:pin-message label=greeting]\`
- \`[discord:react id=123456789 emoji=thumbsup]\`
- \`[discord:edit-message label=greeting content="Updated text"]\` — own messages only
- \`[discord:delete-message label=greeting]\` — own messages only

**Memory (REQUIRED every response):**
Update your memory file at the end of every response. Include the full replacement content:
\`\`\`
[discord:edit-memory]
---MEMORY---
(your full updated memory here)
---END-MEMORY---
\`\`\`
This overwrites your memory file completely. Keep it organized, concise, and up-to-date.
What to track: ongoing tasks, key decisions, things the human asked you to remember, project context, blockers.
What NOT to track: conversation text that's already in history, temporary/one-off info.

**Persona (self-edit):**
When asked to update your persona/personality/character, output the command tag followed by a delimited block:
\`\`\`
[discord:edit-persona]
---PERSONA---
(your full updated persona here)
---END-PERSONA---
\`\`\`
This rewrites your persona file. Include your ENTIRE persona — anything omitted will be lost.

**Legacy (still works):** \`[task:create name @bots]\` and \`[task:done name]\`

## The Message That Triggered You
From: ${invocation.message.teamId === 'human' ? `Human (<@${invocation.message.discordId ?? ''}>)` : invocation.message.teamName}
Content: ${invocation.message.content}

## Available Repositories
${repoList}
${repoRules}

## Your Identity
You are: ${team.name} (engine: ${team.engine}, model: ${team.model})
${team.useTeams ? `
## Agent Teams
You have agent team capabilities enabled. For complex tasks that involve multiple files, parallel work, or multi-step operations, you SHOULD use the team/swarm tools to spawn sub-agents and coordinate work in parallel. This improves speed and quality. For simple single-file tasks, work directly without spawning a team.
${team.teamRules?.length ? `\n### Team Rules\n${team.teamRules.map(r => `- ${r}`).join('\n')}` : ''}` : ''}
`;
}
