import { runHaiku } from './haiku.js';
import type { BotConfig, GlobalConfig, RepoInfo, TriageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Build triage prompt
// ---------------------------------------------------------------------------

function buildTriagePrompt(
  message: string,
  authorName: string,
  authorId: string,
  bot: BotConfig,
  botMemory: string,
  repos: RepoInfo[],
  global: GlobalConfig,
  otherBots: { id: string; name: string; discordUserId?: string }[],
): string {
  const repoSummaries = repos.map(r => {
    const ctx = r.context ? `\n    Context: ${r.context.slice(0, 200)}` : '';
    const wl = r.worklogSummary ? `\n    Recent work:\n${r.worklogSummary.split('\n').slice(-5).map(l => '      ' + l).join('\n')}` : '';
    return `  - ${r.name} → ${r.path}${ctx}${wl}`;
  }).join('\n');

  const botList = otherBots.map(b => `  - ${b.name} (${b.id})${b.discordUserId ? ` <@${b.discordUserId}>` : ''}`).join('\n');

  return `You are a triage system for "${bot.name}" (${bot.id}), a Discord bot.
Your job is to analyze an incoming message and decide what action to take.

## Bot Info
- Name: ${bot.name}
- Role: ${bot.isLeader ? 'Leader — coordinates team, responds to all messages' : 'Team member — executes assigned tasks'}
- Engine: ${bot.engine}/${bot.model}

## Bot's Personal Memory
${botMemory || '(empty)'}

## Available Repositories
${repoSummaries || '(none configured)'}

## Other Bots
${botList || '(none)'}

## Human
${global.humanDiscordId ? `Discord ID: <@${global.humanDiscordId}>, Title: ${global.humanTitle ?? 'Boss'}` : 'Not configured'}

## Incoming Message
From: ${authorName} (Discord ID: ${authorId})
Content: ${message}

## Decision Rules
1. If the message is from the Human (matching Human Discord ID above) AND asks to modify this bot's own persona/memory/allowedDirs/schedule/permissions → self_modify
2. If the message asks for code work in a specific repo → repo_work
3. If the message is a general question, greeting, or status request → reply
4. If the message is not relevant to this bot → ignore
5. For repo_work: choose the best matching repo from Available Repositories
6. For repo_work: write a clear, actionable task description that claude can execute

## Self-Modify Rules (ONLY if sender matches Human Discord ID)
The human can ask you to modify yourself via natural language. Recognize patterns like:
- "페르소나에 ~ 추가해" / "persona에 ~ 추가" → target=persona, operation=append
- "페르소나 이걸로 바꿔: ~" / "persona 교체" → target=persona, operation=replace
- "memory 초기화" / "기억 지워" → target=memory, operation=clear
- "memory를 이걸로 바꿔: ~" → target=memory, operation=replace
- "allowedDirs에 /path 추가" / "작업 레포에 /path 추가" → target=allowedDirs, operation=add, value="/path"
- "allowedDirs에서 /path 제거" → target=allowedDirs, operation=remove, value="/path"
- "schedule 삭제" / "스케줄 꺼" → target=schedule, operation=clear
- "매 2시간마다 자동 실행하게 해" → target=schedule, operation=set, value={"cron":"0 */2 * * *"}
- "idle 15분 후 자동 실행" → target=schedule, operation=set, value={"onIdle":true,"idleDelayMinutes":15}
- "git push 금지" → target=permissions, operation=add, value={"deny":["git push"]}

### CRITICAL for persona/memory replace/append
When the user provides a LARGE persona/memory body (more than ~100 chars, contains
newlines/markdown/quotes), DO NOT embed the content in the JSON "value" field —
JSON escaping of markdown is unreliable.

Instead, detect if the original message contains a delimiter block like:
  ---PERSONA---
  [content]
  ---END-PERSONA---
or:
  \`\`\`persona
  [content]
  \`\`\`

If delimiters are present, output {"action":"self_modify","target":"persona","operation":"replace","confirmMessage":"..."} WITHOUT the value field. The system extracts the content from the original message automatically.

For short values (adding a single line, a path, a cron expression), put them in the "value" field normally.

For self_modify, always include a friendly "confirmMessage" in the bot's own voice (matching the persona).

## Output
Respond with ONLY a JSON object (no markdown fencing):
- repo_work: {"action":"repo_work","repoName":"<name>","repo":"<absolute_path>","task":"<detailed task>"}
- reply: {"action":"reply","message":"<your response text>"}
- ignore: {"action":"ignore"}
- self_modify: {"action":"self_modify","target":"<target>","operation":"<op>","value":<value>,"confirmMessage":"<reply>"}`;
}

// ---------------------------------------------------------------------------
// Parse triage response
// ---------------------------------------------------------------------------

const VALID_TARGETS = new Set(['persona', 'memory', 'allowedDirs', 'schedule', 'permissions']);
const VALID_OPERATIONS = new Set(['replace', 'append', 'add', 'remove', 'clear', 'set']);

function parseTriageResponse(output: string): TriageResult {
  // Strip markdown fences if present
  let json = output.trim();
  const fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) json = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(json);

    if (parsed.action === 'repo_work' && parsed.repo && parsed.task) {
      return {
        action: 'repo_work',
        repo: parsed.repo,
        repoName: parsed.repoName || '',
        task: parsed.task,
      };
    }

    if (parsed.action === 'reply' && parsed.message) {
      return { action: 'reply', message: parsed.message };
    }

    if (parsed.action === 'ignore') {
      return { action: 'ignore' };
    }

    if (parsed.action === 'self_modify'
        && VALID_TARGETS.has(parsed.target)
        && VALID_OPERATIONS.has(parsed.operation)) {
      return {
        action: 'self_modify',
        target: parsed.target,
        operation: parsed.operation,
        value: parsed.value,
        confirmMessage: parsed.confirmMessage || 'Applied.',
      };
    }
  } catch {
    // If JSON parsing fails, treat as a direct reply
  }

  // Fallback: if output looks like a message, treat as reply
  if (output.trim().length > 0) {
    return { action: 'reply', message: output.trim() };
  }

  return { action: 'ignore' };
}

// ---------------------------------------------------------------------------
// Main triage function
// ---------------------------------------------------------------------------

export async function triage(
  message: string,
  authorName: string,
  authorId: string,
  bot: BotConfig,
  botMemory: string,
  repos: RepoInfo[],
  global: GlobalConfig,
  otherBots: { id: string; name: string; discordUserId?: string }[],
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(message, authorName, authorId, bot, botMemory, repos, global, otherBots);

  try {
    const output = await runHaiku(prompt);
    return parseTriageResponse(output);
  } catch (err) {
    console.error(`[triage:${bot.id}] Haiku error:`, err);
    // On triage failure, ignore to avoid broken responses
    return { action: 'ignore' };
  }
}
