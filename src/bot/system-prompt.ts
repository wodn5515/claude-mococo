import { loadWorklog } from '../config.js';
import type { BotConfig, GlobalConfig } from '../types.js';

/**
 * Build the system prompt injected via --append-system-prompt.
 *
 * This is appended AFTER the repo's own CLAUDE.md (which claude loads natively).
 * Contains: bot persona, personal memory, repo worklog, team rules.
 */
export function buildSystemPrompt(
  bot: BotConfig,
  persona: string,
  botMemory: string,
  repoName: string,
  global: GlobalConfig,
): string {
  const worklog = loadWorklog(repoName);
  const recentWorklog = worklog
    ? worklog.split('\n').slice(-30).join('\n')
    : '(no work history)';

  const currentTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

  const sections: string[] = [];

  // Persona
  if (persona) {
    sections.push(`## Your Persona\n${persona}`);
  }

  // Identity & context
  sections.push(`## Context
- You are: ${bot.name} (${bot.id})
- Current time: ${currentTime}
- Working in repo: ${repoName}
- Human title: ${global.humanTitle ?? 'Boss'}${global.humanDiscordId ? `\n- Human Discord ID: <@${global.humanDiscordId}>` : ''}`);

  // Personal memory
  sections.push(`## Your Personal Memory
${botMemory || '(empty)'}

After completing your task, output a memory update block:
\`\`\`
---MEMORY---
(your updated personal memory — what you did, what's pending, key context)
---END-MEMORY---
\`\`\``);

  // Repo worklog
  sections.push(`## Recent Work in This Repo (all bots)
${recentWorklog}`);

  // Permissions
  const denied = [...(global.globalDeny || []), ...(bot.permissions.deny || [])];
  if (denied.length > 0) {
    sections.push(`## Denied Commands
These commands are FORBIDDEN: ${denied.join(', ')}`);
  }

  // Communication
  sections.push(`## Communication
When you need to communicate results or tag other bots/people, include it in your text output.
Your output will be posted to Discord as-is.`);

  return sections.join('\n\n');
}
