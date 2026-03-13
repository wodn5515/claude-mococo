import fs from 'node:fs';
import path from 'node:path';
import { formatConversation } from '../teams/context.js';
import { loadRecentEpisodes } from '../bot/episode-writer.js';
import { getStressModifier } from '../bot/stress-tracker.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

const MAX_INBOX_ENTRIES = 20;
const MAX_ENTRY_CHARS = 200;

// File cache for rarely-changing files (shared rules, member list)
// File cache: compare both mtime + size for accurate change detection
const fileCache = new Map<string, { content: string; cachedAt: number; size: number; mtimeMs: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function readCached(filePath: string): string {
  const now = Date.now();
  const cached = fileCache.get(filePath);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    // Invalidate cache if file size/mtime changed even within TTL
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === cached.size && stat.mtimeMs === cached.mtimeMs) {
        return cached.content;
      }
    } catch {
      fileCache.delete(filePath);
      return '';
    }
  }

  try {
    // Single stat call for size/mtime check then read content (avoid double stat)
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    fileCache.set(filePath, { content, cachedAt: now, size: stat.size, mtimeMs: stat.mtimeMs });
    return content;
  } catch {
    // File deleted or unreadable — invalidate stale cache entry if present
    fileCache.delete(filePath);
    return '';
  }
}

/**
 * Summarize inbox: truncate long messages, keep recent entries,
 * prioritize messages that mention this team.
 */
function summarizeInbox(raw: string, teamId: string): string {
  if (!raw) return '';

  const lines = raw.split('\n');

  // Merge continuation lines into the preceding entry.
  // A new entry starts with a timestamp pattern like "[2026-02-19 02:40 #ch:..."
  // Using specific pattern avoids false splits on markdown links like "[text](url)".
  const ENTRY_START = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;
  const merged: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (ENTRY_START.test(line)) {
      merged.push(line);
    } else if (merged.length > 0) {
      merged[merged.length - 1] += ' ' + line.trim();
    }
    // Orphan lines before any entry are dropped (no valid timestamp prefix)
  }

  // Parse into entries (each line is "[timestamp] sender: content")
  const failedLines: string[] = [];
  const entries = merged.map(line => {
    const match = line.match(/^\[([^\]]+)\]\s+([^:]+):\s*([\s\S]*)$/);
    if (!match) {
      failedLines.push(line);
      return { ts: '', from: '', content: line, mentionsMe: false };
    }
    return {
      ts: match[1],
      from: match[2],
      content: match[3],
      mentionsMe: match[3].toLowerCase().includes(teamId),
    };
  });
  if (failedLines.length > 0) {
    const sample = failedLines.length <= 3
      ? failedLines.map(l => l.slice(0, 80)).join('; ')
      : failedLines.slice(0, 3).map(l => l.slice(0, 80)).join('; ') + '...';
    const failRatio = failedLines.length / merged.length;
    if (failRatio > 0.5) {
      console.error(`[summarizeInbox] ${teamId}: ${failedLines.length}/${merged.length} entries failed to parse (${(failRatio * 100).toFixed(0)}% — majority) — ${sample}`);
    } else {
      console.warn(`[summarizeInbox] ${teamId}: ${failedLines.length}/${merged.length} entries failed to parse — ${sample}`);
    }
  }

  // Prioritize mentions, fill remaining with most recent others
  const mentioning = entries.filter(e => e.mentionsMe).slice(-MAX_INBOX_ENTRIES);
  const others = entries.filter(e => !e.mentionsMe);
  const remaining = MAX_INBOX_ENTRIES - mentioning.length;
  const kept = [...mentioning, ...(remaining > 0 ? others.slice(-remaining) : [])];

  // Format with truncation
  return kept.map(e => {
    const truncated = e.content.length > MAX_ENTRY_CHARS
      ? e.content.slice(0, MAX_ENTRY_CHARS) + '...'
      : e.content;
    return e.ts ? `[${e.ts}] ${e.from}: ${truncated}` : truncated;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Data-loading helpers
// ---------------------------------------------------------------------------

function buildTeamDirectory(config: TeamsConfig, currentTeamId: string): string {
  return Object.values(config.teams)
    .filter(t => t.id !== currentTeamId)
    .map(t => {
      const engineTag = t.engine !== 'claude' ? ` [${t.engine}]` : '';
      const mention = t.discordUserId ? ` → tag with <@${t.discordUserId}>` : '';
      return `- @${t.name}${engineTag}${mention}`;
    })
    .join('\n');
}

function loadRepoContext(ws: string, messageContent: string): { repoRules: string; repoList: string } {
  // Repo-specific rules
  let repoRules = '';
  const repoMatch = messageContent.match(/repos\/(\S+)/);
  if (repoMatch) {
    const repoRulesPath = path.resolve(ws, `prompts/repo-specific/${repoMatch[1]}.md`);
    if (fs.existsSync(repoRulesPath)) {
      repoRules = `\n\n## Repository-Specific Rules\n${fs.readFileSync(repoRulesPath, 'utf-8')}`;
    }
  }

  // Available repos
  let repos: string[] = [];
  try {
    repos = fs.readdirSync(path.resolve(ws, 'repos')).filter(f => f !== '.gitkeep');
  } catch {
    // repos dir may not exist
  }
  const repoList = repos.length > 0
    ? repos.map(r => `- repos/${r}`).join('\n')
    : '(no repos linked yet)';

  return { repoRules, repoList };
}

function migrateAndLoadMemory(ws: string, teamId: string): { longTerm: string; shortTerm: string } {
  const memoryDir = path.resolve(ws, '.mococo/memory', teamId);
  const longTermPath = path.resolve(memoryDir, 'long-term.md');
  const shortTermPath = path.resolve(memoryDir, 'short-term.md');

  // Migration: if old flat file exists and new dir doesn't, move it
  const legacyPath = path.resolve(ws, '.mococo/memory', `${teamId}.md`);
  try {
    if (fs.existsSync(legacyPath) && !fs.existsSync(shortTermPath)) {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.renameSync(legacyPath, shortTermPath);
      console.log(`[memory] Migrated ${teamId}.md → ${teamId}/short-term.md`);
    }
  } catch (err) {
    console.warn(`[memory] Legacy migration failed for ${teamId}: ${err}`);
  }

  let longTerm = '';
  let shortTerm = '';
  try { longTerm = fs.readFileSync(longTermPath, 'utf-8').trim(); } catch { /* no long-term memory yet */ }
  try { shortTerm = fs.readFileSync(shortTermPath, 'utf-8').trim(); } catch { /* no short-term memory yet */ }

  return { longTerm, shortTerm };
}

function loadInbox(ws: string, team: TeamConfig, preloadedInbox?: string): string {
  if (!team.isLeader) return '';

  if (preloadedInbox !== undefined) {
    return summarizeInbox(preloadedInbox, team.id);
  }

  const inboxPath = path.resolve(ws, '.mococo/inbox', `${team.id}.md`);
  try {
    return summarizeInbox(
      fs.readFileSync(inboxPath, 'utf-8').trim(),
      team.id,
    );
  } catch {
    return ''; // no inbox yet
  }
}

// ---------------------------------------------------------------------------
// Prompt section builders
// ---------------------------------------------------------------------------

function buildMemorySection(longTerm: string, shortTerm: string, chId: string, humanTitle: string, isFirstInvocation: boolean): string {
  if (isFirstInvocation) {
    // Full guide with examples on first invocation
    return `## Long-term Memory
Important knowledge that persists permanently. Only update when you have something worth keeping forever.
Use these sections to organize:

### Users & Members
Example:
- ${humanTitle}: prefers Korean, values code quality, weekly Monday reports
- @dev-member: backend specialist, TypeScript focus

### Projects & Structure
Example:
- mococo-api: Express + TypeScript, repos/mococo-api
- Deploy: main → staging auto, production manual

### Policies & Rules
Example:
- PR merge is ${humanTitle}-only
- Hotfixes can be autonomous, feature additions need proposal

### Team Capabilities
Example:
- Backend team: API design, DB migrations, performance optimization
- Frontend team: React, deploy pipelines, UI/UX

${longTerm ? `\n${longTerm}\n` : '\n(empty)\n'}
## Short-term Memory
Working context for current tasks. Update every response.
Use these sections to organize:

### In Progress
(current tasks, assignees, blockers — must include #ch:numericID)
Example:
- Writing FE deploy script #ch:${chId}
- Delegated API integration to member A, awaiting result #ch:${chId}

### Waiting
(incomplete tasks — must include #ch:numericID. Tags: [BLOCKED], [SCHEDULED:YYYY-MM-DD], [READY])
Example:
- DB migration execution #ch:1234567890123456
- Redis setup [BLOCKED] — waiting for member A #ch:1234567890123456
- Weekly report [SCHEDULED:2026-02-17] #ch:9876543210123456

### Cached External Data
(API query results + query time. Re-query if older than 24 hours.)
Example:
- [2/12 10:30] Calendar: 3 events today (team meeting 14:00, code review 16:00)
- [2/12 09:00] GitHub PR: #142 review pending, #140 merged

⚠️ After #ch: you must write the actual Discord channel ID (numeric). Current channel ID: ${chId}
${shortTerm ? `\n${shortTerm}\n` : '\n(empty)\n'}`;
  }

  // Condensed version for subsequent invocations — omit examples, keep structure
  return `## Long-term Memory
${longTerm || '(empty)'}

## Short-term Memory
Sections: In Progress, Waiting (with #ch:channelId), Cached External Data. Current channel: ${chId}
${shortTerm || '(empty)'}
`;
}

function buildDiscordCommandsSection(team: TeamConfig, humanTitle: string, leaderName: string, isFirstInvocation: boolean): string {
  const leaderDecisionLog = `
**Decision Log (autonomous decisions — leader only):**
\`[decision:level reason="description" action="action taken"]\`
Levels: \`autonomous\` (routine), \`inform\` (within scope), \`propose\` (new features — await ${humanTitle}), \`escalate\` (urgent — tag ${humanTitle})
`;

  const memberImprovementNote = `
**When discovering improvements (non-leader teams only):**
If you find bugs, security vulnerabilities, performance issues, or code needing refactoring, report to ${leaderName}.
Tag ${leaderName} at the end of your output with a brief description:
Example: \`<@leaderID> [found] medium: duplicate code in utils.ts, needs refactoring\`
The system will automatically invoke ${leaderName} for evaluation.
`;

  if (!isFirstInvocation) {
    // Condensed version — only memory syntax reminders and role-specific section
    return `## Discord Commands
Syntax: \`[discord:action key=value key="quoted value"]\`
Available actions: create/delete/rename-channel, set-topic, move-channel, create/archive/lock-thread, send-thread, create/delete-category, pin-message, react, edit/delete-message, create/delete/assign/remove-role, list-roles, list-channels, set/remove-permission.

**Short-term Memory (REQUIRED every response):**
\`\`\`
---MEMORY---
(current working context, pruned and updated)
---END-MEMORY---
\`\`\`
**⚠️ Incomplete tasks MUST include #ch:channelId in Waiting section.**

**Long-term Memory:** Use \`---LONG-MEMORY---\` / \`---END-LONG-MEMORY---\` block when updating permanent knowledge.
**Persona:** Use \`[discord:edit-persona]\` + \`---PERSONA---\` / \`---END-PERSONA---\` block to self-edit.
${team.isLeader ? leaderDecisionLog : memberImprovementNote}`;
  }

  // Full version with all examples — first invocation only
  return `## Discord Commands
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

**Roles:**
- \`[discord:create-role name=Developer]\` — create a role
- \`[discord:create-role name=Developer color="#2ECC71"]\` — create with color
- \`[discord:delete-role name=Developer]\`
- \`[discord:assign-role role=Developer user=123456789]\` — assign role to user
- \`[discord:remove-role role=Developer user=123456789]\` — remove role from user
- \`[discord:list-roles]\` — list server roles (name, member count)
- \`[discord:list-channels]\` — list server channels (grouped by category)

**Permissions (channel/category):**
- \`[discord:set-permission channel=my-channel role=Developer allow="ViewChannel,SendMessages"]\`
- \`[discord:set-permission channel=my-channel role=Developer deny="SendMessages"]\` — read-only
- \`[discord:set-permission category=Projects user=123456789 allow="ViewChannel"]\`
- \`[discord:set-permission channel=my-channel role=Developer allow="ViewChannel" deny="SendMessages"]\` — allow+deny simultaneously
- \`[discord:remove-permission channel=my-channel role=Developer]\` — remove all permission overrides for that target
Available permissions: ViewChannel, SendMessages, ReadMessageHistory, ManageMessages, ManageChannels, ManageRoles, EmbedLinks, AttachFiles, AddReactions, Connect, Speak, MentionEveryone, CreatePublicThreads, CreatePrivateThreads, UseExternalEmojis

**Short-term Memory (REQUIRED every response):**
Update your short-term memory at the end of every response. Include the full replacement content:
\`\`\`
---MEMORY---
(current working context, pruned and updated)
---END-MEMORY---
\`\`\`
This overwrites your short-term memory completely. Keep it lean and up-to-date.
What to track: ongoing tasks, current blockers, temp context needed for next invocation.
What NOT to track: conversation text already in history, stable facts (promote those to long-term).
**⚠️ Incomplete tasks MUST be recorded in the "### Waiting" section with #ch:channelId.** Example: \`- Finish API integration #ch:123456789\`

**Long-term Memory (only when needed):**
When you learn something worth keeping permanently, also output:
\`\`\`
---LONG-MEMORY---
(full long-term memory content — only output when adding/updating permanent knowledge)
---END-LONG-MEMORY---
\`\`\`
This overwrites long-term memory completely — include ALL existing long-term entries plus new ones.
What to promote: user preferences, project structure, recurring schedules, key decisions, team capabilities.
Only output this block when you have something new to add or need to update existing entries.

**Persona (self-edit):**
When asked to update your persona/personality/character, output the command tag followed by a delimited block:
\`\`\`
[discord:edit-persona]
---PERSONA---
(your full updated persona here)
---END-PERSONA---
\`\`\`
This rewrites your persona file. Include your ENTIRE persona — anything omitted will be lost.
${team.isLeader ? leaderDecisionLog : memberImprovementNote}`;
}

// ---------------------------------------------------------------------------
// Main prompt builder (orchestrator)
// ---------------------------------------------------------------------------

export async function buildTeamPrompt(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
  preloadedInbox?: string,
): Promise<string> {
  const ws = config.workspacePath;
  const chId = invocation.channelId;

  // 1. Load base resources (with path traversal guard)
  const templatePath = path.resolve(ws, team.prompt);
  if (!templatePath.startsWith(ws + path.sep) && templatePath !== ws) {
    throw new Error(`[prompt-builder] Path traversal detected: team.prompt "${team.prompt}" resolves outside workspace`);
  }
  const template = fs.readFileSync(templatePath, 'utf-8');
  const conversationText = formatConversation(invocation.conversation);
  const rawSharedRules = readCached(path.resolve(ws, 'prompts/shared-rules.md'));
  const memberList = readCached(path.resolve(ws, '.mococo/members.md'));

  // Resolve placeholders in shared rules
  const humanTitle = config.humanTitle ?? 'Boss';
  const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
  const leaderName = leaderTeam?.name ?? 'Leader';

  // Conditionally load New Agent Protocol only when relevant
  const messageContent = invocation.message.content;
  const isNewAgentEvent = messageContent.includes('[신규 모코코 입장]')
    || messageContent.includes('[New Agent Joined]');
  let newAgentProtocol = '';
  if (isNewAgentEvent) {
    const rawProtocol = readCached(path.resolve(ws, 'prompts/new-agent-protocol.md'));
    newAgentProtocol = rawProtocol
      .replace(/\{\{humanTitle\}\}/g, humanTitle)
      .replace(/\{\{leaderName\}\}/g, leaderName);
  }

  const sharedRules = rawSharedRules
    .replace(/\{\{humanTitle\}\}/g, humanTitle)
    .replace(/\{\{leaderName\}\}/g, leaderName);

  // 2. Build dynamic context
  const teamDirectory = buildTeamDirectory(config, team.id);
  const { repoRules, repoList } = loadRepoContext(ws, invocation.message.content);
  const { longTerm, shortTerm } = migrateAndLoadMemory(ws, team.id);
  const inbox = loadInbox(ws, team, preloadedInbox);

  // 3. Load temporal context
  const recentEpisodes = loadRecentEpisodes(team.id, ws);
  const currentTime = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Determine if this is the first invocation for this team (no existing short-term memory)
  const isFirstInvocation = !shortTerm;

  // 4. Build prompt sections
  const memorySection = buildMemorySection(longTerm, shortTerm, chId, humanTitle, isFirstInvocation);
  const discordCommands = buildDiscordCommandsSection(team, humanTitle, leaderName, isFirstInvocation);

  // 5. Build inbox/memory instruction (leader vs member)
  const inboxInstruction = team.isLeader
    ? `## Inbox (messages since your last response)
${inbox ? `\n${inbox}\n` : '(no new messages)\n'}
**You MUST update your short-term memory at the end of every response** using the memory command (see Discord Commands below). Review your current memory AND inbox above, incorporate new information, and remove anything outdated. The inbox is cleared after you respond, so anything you don't save to memory will be lost.`
    : `**You MUST update your short-term memory at the end of every response** using the memory command (see Discord Commands below). Review your current memory, incorporate new information, and remove anything outdated.`;

  // 6. Build mention info
  const humanMention = config.humanDiscordId ? `- Human (${humanTitle}): <@${config.humanDiscordId}>` : '';
  const triggerMention = invocation.message.discordId && invocation.message.discordId !== config.humanDiscordId
    ? `\n- ${invocation.message.teamName}: <@${invocation.message.discordId}>`
    : '';

  // 7. Build trigger info
  const triggerFrom = invocation.message.teamId === 'human'
    ? `Human (<@${invocation.message.discordId ?? ''}>)`
    : invocation.message.teamName;

  // 8. Agent teams section
  const agentTeamsSection = team.useTeams
    ? `\n## Agent Teams
You have agent team capabilities enabled. For complex tasks that involve multiple files, parallel work, or multi-step operations, you SHOULD use the team/swarm tools to spawn sub-agents and coordinate work in parallel. This improves speed and quality. For simple single-file tasks, work directly without spawning a team.
${team.teamRules?.length ? `\n### Team Rules\n${team.teamRules.map(r => `- ${r}`).join('\n')}` : ''}`
    : '';

  // 9. Build stress modifier (Current Mood)
  const stressMood = getStressModifier(ws, team.id, team.stressProfile);

  // 10. Assemble final prompt
  return `${template}
${stressMood ? `\n${stressMood}\n` : ''}${sharedRules ? `\n${sharedRules}\n` : ''}${newAgentProtocol ? `\n${newAgentProtocol}\n` : ''}
## Current Context
Current channel: ${chId}
Current time: ${currentTime}

${memorySection}
## Recent Activity (auto-generated — do not edit)
Summary of recent activity. Review what was done in previous invocations to maintain context.
${recentEpisodes || '(no recent activity)'}

${inboxInstruction}
**⚠️ CRITICAL: Always check memory before calling external tools.**
- Never re-call APIs for data already in Short-term/Long-term Memory.
- Example: If a week's schedule is already in memory, extract today's events from memory. Don't fetch the same data again.
- Only call external tools (APIs, MCP servers) when: no related data in memory, data is stale (24h+), or user explicitly requests a fresh query.

## Server Members
${memberList || '(no member data)'}

## Team Directory
These are the teams you can tag. Mention @TeamName to hand off work:
${teamDirectory}

## Discord Conversation (recent)
\`\`\`
${conversationText}
\`\`\`

## Discord Mentions
**Sending: Always tag everyone you're addressing. No exceptions.**
- For 1 recipient: start with \`<@ID>\`
- For multiple: list all: \`<@ID1> <@ID2> <@ID3>\`
- Replies, reports, delegations, questions — always tag

${humanMention}${triggerMention}

${discordCommands}
## The Message That Triggered You
From: ${triggerFrom}
Content: ${invocation.message.content}

## Available Repositories
${repoList}
${repoRules}

## Your Identity
You are: ${team.name} (engine: ${team.engine}, model: ${team.model})
${agentTeamsSection}
`;
}
