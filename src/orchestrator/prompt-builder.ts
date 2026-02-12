import fs from 'node:fs';
import path from 'node:path';
import { formatConversation } from '../teams/context.js';
import { loadRecentEpisodes } from '../bot/episode-writer.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

const MAX_INBOX_ENTRIES = 20;
const MAX_ENTRY_CHARS = 200;

// File cache for rarely-changing files (shared rules, member list)
const fileCache = new Map<string, { content: string; mtime: number }>();
const CACHE_TTL_MS = 5 * 60_000; // 5 minutes

function readCached(filePath: string): string {
  const now = Date.now();
  const cached = fileCache.get(filePath);
  if (cached && now - cached.mtime < CACHE_TTL_MS) return cached.content;

  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    fileCache.set(filePath, { content, mtime: now });
    return content;
  } catch {
    return '';
  }
}

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

export async function buildTeamPrompt(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
  preloadedInbox?: string,
): Promise<string> {
  const ws = config.workspacePath;
  const template = fs.readFileSync(path.resolve(ws, team.prompt), 'utf-8');
  const conversationText = formatConversation(invocation.conversation);

  // Load shared rules (cached — rarely changes)
  const sharedRules = readCached(path.resolve(ws, 'prompts/shared-rules.md'));

  // Load shared member list (cached — changes infrequently)
  const memberList = readCached(path.resolve(ws, '.mococo/members.md'));

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
  } catch (err) {
    console.warn(`[memory] Legacy migration failed for ${team.id}: ${err}`);
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

  // Load inbox (leader only — non-leaders get context via reactive dispatch)
  let inbox = '';
  if (team.isLeader) {
    if (preloadedInbox !== undefined) {
      inbox = summarizeInbox(preloadedInbox, team.id);
    } else {
      const inboxPath = path.resolve(ws, '.mococo/inbox', `${team.id}.md`);
      try {
        inbox = summarizeInbox(
          fs.readFileSync(inboxPath, 'utf-8').trim(),
          team.id,
        );
      } catch {
        // no inbox yet — that's fine
      }
    }
  }

  const recentEpisodes = loadRecentEpisodes(team.id, ws);
  const currentTime = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const chId = invocation.channelId;

  return `${template}
${sharedRules ? `\n${sharedRules}\n` : ''}
## Current Context
현재 채널: ${chId}
현재 시각: ${currentTime}

## Long-term Memory
Important knowledge that persists permanently. Only update when you have something worth keeping forever.
Use these sections to organize:

### 사용자 & 멤버
예시:
- 회장님: 한국어 선호, 코드 품질 중시, 매주 월요일 주간보고
- @김개발: 백엔드 전문, TypeScript 주력

### 프로젝트 & 구조
예시:
- mococo-api: Express + TypeScript, repos/mococo-api
- 배포: main → staging 자동, production 수동

### 정책 & 규칙
예시:
- PR 머지는 회장님만 가능
- 핫픽스는 autonomous 결정 가능, 기능 추가는 propose

### 팀 역량
예시:
- BE코코: API 설계, DB 마이그레이션, 성능 최적화
- FE코코: React, 배포 파이프라인, UI/UX

${longTermMemory ? `\n${longTermMemory}\n` : '\n(empty)\n'}
## Short-term Memory
Working context for current tasks. Update every response.
Use these sections to organize:

### 진행중 작업
(현재 태스크, 담당자, 블로커 — 반드시 #ch:숫자ID 포함)
예시:
- FE 배포 스크립트 작성 중 #ch:${chId}
- BE코코에게 API 연동 위임, 결과 대기 #ch:${chId}

### 대기 항목
(미완료 작업 — 반드시 #ch:숫자ID 포함. 태그: [BLOCKED], [SCHEDULED:YYYY-MM-DD], [READY])
예시:
- DB 마이그레이션 실행 #ch:1234567890123456
- Redis 설정 [BLOCKED] — BE코코 완료 대기 #ch:1234567890123456
- 주간보고 작성 [SCHEDULED:2026-02-17] #ch:9876543210123456

### 캐시된 외부 데이터
(API 조회 결과 + 조회 시각. 24시간 이상 경과 시 재조회 필요.)
예시:
- [2/12 10:30] 캘린더: 오늘 일정 3건 (팀미팅 14:00, 코드리뷰 16:00)
- [2/12 09:00] GitHub PR: #142 리뷰 대기, #140 머지 완료

⚠️ #ch: 뒤에는 반드시 실제 Discord 채널 ID(숫자)를 적어라. 현재 채널 ID: ${chId}
${shortTermMemory ? `\n${shortTermMemory}\n` : '\n(empty)\n'}
## Recent Activity (자동 생성 — 수정 불필요)
최근 활동 요약. 이전 호출에서 무엇을 했는지 파악하여 맥락을 이어가라.
${recentEpisodes || '(no recent activity)'}

${team.isLeader ? `## Inbox (messages since your last response)
${inbox ? `\n${inbox}\n` : '(no new messages)\n'}
**You MUST update your short-term memory at the end of every response** using the memory command (see Discord Commands below). Review your current memory AND inbox above, incorporate new information, and remove anything outdated. The inbox is cleared after you respond, so anything you don't save to memory will be lost.` : `**You MUST update your short-term memory at the end of every response** using the memory command (see Discord Commands below). Review your current memory, incorporate new information, and remove anything outdated.`}
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
${team.isLeader ? `
**Decision Log (자율 결정 기록 — 리더 전용):**
자율적으로 결정을 내릴 때 반드시 다음 태그를 출력에 포함:
\`[decision:level reason="설명" action="조치 내용"]\`

Levels:
- \`autonomous\` — 루틴 작업 (버그 수정, 리팩토링, 작업 재분배). 실행 후 기록만.
- \`inform\` — 기존 범위 내 개선. 실행 후 보고.
- \`propose\` — 새 기능, 아키텍처 변경, 새 도구 도입. 회장님 승인 대기.
- \`escalate\` — 보안, 장애, 긴급. 즉시 회장님 태그.

예: \`[decision:autonomous reason="중복 코드 발견" action="BE코코에게 리팩토링 지시"]\`
예: \`[decision:propose reason="새 인증 시스템 필요" action="회장님 승인 대기"]\`
` : `
**개선사항 발견 시 (비리더 팀 전용):**
작업 중 버그, 보안 취약점, 성능 이슈, 리팩토링 필요 코드를 발견하면 대장코코에게 보고하라.
output 마지막에 대장코코를 태그하고 발견 내용을 간단히 기술:
예: \`<@대장코코ID> [발견] medium: utils.ts에 중복 코드, 리팩토링 필요\`
이렇게 하면 시스템이 자동으로 대장코코를 invoke하여 판단한다.
`}
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
