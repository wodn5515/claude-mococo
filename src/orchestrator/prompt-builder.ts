import fs from 'node:fs';
import path from 'node:path';
import { formatConversation } from '../teams/context.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

const MAX_INBOX_ENTRIES = 20;
const MAX_ENTRY_CHARS = 200;

/**
 * Summarize inbox: truncate long messages, keep recent entries,
 * prioritize messages that mention this team.
 */
function summarizeInbox(raw: string, teamId: string): string {
  if (!raw) return '';

  const lines = raw.split('\n').filter(l => l.trim());

  // Parse into entries (each line is "[timestamp] sender: content")
  const entries = lines.map(line => {
    const match = line.match(/^\[([^\]]+)\]\s+([^:]+):\s*([\s\S]*)$/);
    if (!match) return { ts: '', from: '', content: line, mentionsMe: false };
    return {
      ts: match[1],
      from: match[2],
      content: match[3],
      mentionsMe: match[3].toLowerCase().includes(teamId),
    };
  });

  // Sort: mentions-me first, then by recency (original order = chronological)
  const mentioning = entries.filter(e => e.mentionsMe);
  const others = entries.filter(e => !e.mentionsMe);
  const sorted = [...mentioning, ...others];

  // Keep only the most recent entries
  const kept = sorted.slice(-MAX_INBOX_ENTRIES);

  // Format with truncation
  return kept.map(e => {
    const truncated = e.content.length > MAX_ENTRY_CHARS
      ? e.content.slice(0, MAX_ENTRY_CHARS) + '...'
      : e.content;
    return e.ts ? `[${e.ts}] ${e.from}: ${truncated}` : truncated;
  }).join('\n');
}

export async function buildTeamPrompt(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
): Promise<string> {
  const ws = config.workspacePath;
  const template = fs.readFileSync(path.resolve(ws, team.prompt), 'utf-8');
  const conversationText = formatConversation(invocation.conversation);

  // Load shared rules (injected for every team)
  let sharedRules = '';
  const sharedRulesPath = path.resolve(ws, 'prompts/shared-rules.md');
  try {
    sharedRules = fs.readFileSync(sharedRulesPath, 'utf-8').trim();
  } catch {
    // no shared rules file — that's fine
  }

  // Load shared member list
  let memberList = '';
  const membersPath = path.resolve(ws, '.mococo/members.md');
  try {
    memberList = fs.readFileSync(membersPath, 'utf-8').trim();
  } catch {
    // no member list yet
  }

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

  // Load persistent memory (long-term + short-term)
  const memoryDir = path.resolve(ws, '.mococo/memory', team.id);
  const longTermPath = path.resolve(memoryDir, 'long-term.md');
  const shortTermPath = path.resolve(memoryDir, 'short-term.md');

  // Migration: if old flat file exists and new dir doesn't, move it
  const legacyPath = path.resolve(ws, '.mococo/memory', `${team.id}.md`);
  try {
    if (fs.existsSync(legacyPath) && !fs.existsSync(shortTermPath)) {
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.renameSync(legacyPath, shortTermPath);
      console.log(`[memory] Migrated ${team.id}.md → ${team.id}/short-term.md`);
    }
  } catch {
    // migration failed — not critical
  }

  let longTermMemory = '';
  let shortTermMemory = '';
  try {
    longTermMemory = fs.readFileSync(longTermPath, 'utf-8').trim();
  } catch {
    // no long-term memory yet
  }
  try {
    shortTermMemory = fs.readFileSync(shortTermPath, 'utf-8').trim();
  } catch {
    // no short-term memory yet
  }

  // Load inbox (messages received since last invocation) and summarize
  const inboxPath = path.resolve(ws, '.mococo/inbox', `${team.id}.md`);
  let inbox = '';
  try {
    inbox = summarizeInbox(
      fs.readFileSync(inboxPath, 'utf-8').trim(),
      team.id,
    );
  } catch {
    // no inbox yet — that's fine
  }

  return `${template}
${sharedRules ? `\n${sharedRules}\n` : ''}
## Long-term Memory
Important knowledge that persists permanently. Only update when you have something worth keeping forever.
Use these sections to organize:
\`\`\`
### 사용자 & 멤버
(선호도, 역할, 관계, 성향)
### 프로젝트 & 구조
(레포, 기술 스택, 아키텍처 결정)
### 정책 & 규칙
(팀 내 합의, 업무 프로세스, 반복 일정)
### 팀 역량
(각 팀/멤버의 능력, 담당 업무)
\`\`\`
${longTermMemory ? `\n${longTermMemory}\n` : '\n(empty)\n'}
## Short-term Memory
Working context for current tasks. Update every response:
- Add new relevant info from your response
- Promote important items to long-term memory
- Delete outdated or useless entries
- Keep it lean — only what's needed for your next invocation
Use these sections to organize:
\`\`\`
### 진행중 작업
(현재 태스크, 담당자, 블로커)
### 최근 결정 & 약속
(최근 대화에서 나온 합의, 약속)
### 대기 항목
(미완료 작업 — 반드시 #ch:channelId 포함. 예: - API 연동 마무리 #ch:123456789)
### 캐시된 외부 데이터
(최근 API 조회 결과 + 조회 시각)
\`\`\`
**⚠️ 진행중 작업 및 대기 항목에는 반드시 #ch:channelId를 포함하라.** 이 정보가 있어야 자동 실행 루프가 어느 채널에서 작업을 이어할지 알 수 있다.
${shortTermMemory ? `\n${shortTermMemory}\n` : '\n(empty)\n'}
## Inbox (messages since your last response)
${inbox ? `\n${inbox}\n` : '(no new messages)\n'}
**You MUST update your short-term memory at the end of every response** using the memory command (see Discord Commands below). Review your current memory AND inbox above, incorporate new information, and remove anything outdated. The inbox is cleared after you respond, so anything you don't save to memory will be lost.
**⚠️ CRITICAL: 외부 도구 호출 전 반드시 메모리를 먼저 확인하라.**
- Short-term/Long-term Memory에 이미 있는 데이터는 절대 다시 API 호출하지 마라.
- 예: 일주일치 일정을 이미 조회해서 메모리에 있으면, 오늘 일정을 물어봤을 때 메모리에서 추출하라. 같은 데이터를 또 API로 가져오지 마라.
- 외부 도구(API, MCP 서버)는 메모리에 관련 데이터가 전혀 없거나, 데이터가 오래되었거나(24시간+), 사용자가 명시적으로 "새로 조회해줘"라고 요청한 경우에만 호출하라.

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
**보내기: 말을 전달하려는 대상은 반드시 전부 태그한다. 예외 없음.**
- 대상이 1명이면 \`<@ID>\`로 시작
- 대상이 여러 명이면 전부 나열: \`<@ID1> <@ID2> <@ID3>\`로 시작
- 답변, 보고, 위임, 질문 — 모든 경우에 태그

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

**Roles:**
- \`[discord:create-role name=Developer]\` — create a role
- \`[discord:create-role name=Developer color="#2ECC71"]\` — create with color
- \`[discord:delete-role name=Developer]\`
- \`[discord:assign-role role=Developer user=123456789]\` — assign role to user
- \`[discord:remove-role role=Developer user=123456789]\` — remove role from user
- \`[discord:list-roles]\` — 서버 역할 목록 조회 (이름, 멤버 수)
- \`[discord:list-channels]\` — 서버 채널 목록 조회 (카테고리별 그룹핑)

**Permissions (channel/category):**
- \`[discord:set-permission channel=my-channel role=Developer allow="ViewChannel,SendMessages"]\`
- \`[discord:set-permission channel=my-channel role=Developer deny="SendMessages"]\` — read-only
- \`[discord:set-permission category=Projects user=123456789 allow="ViewChannel"]\`
- \`[discord:set-permission channel=my-channel role=Developer allow="ViewChannel" deny="SendMessages"]\` — allow+deny 동시 가능
- \`[discord:remove-permission channel=my-channel role=Developer]\` — 해당 대상의 권한 덮어쓰기 전부 제거
사용 가능한 권한: ViewChannel, SendMessages, ReadMessageHistory, ManageMessages, ManageChannels, ManageRoles, EmbedLinks, AttachFiles, AddReactions, Connect, Speak, MentionEveryone, CreatePublicThreads, CreatePrivateThreads, UseExternalEmojis

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
**⚠️ 미완료 작업은 반드시 "### 대기 항목" 섹션에 #ch:channelId와 함께 기록하라.** 예: \`- API 연동 마무리 #ch:123456789\`

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
