import { runHaiku } from './haiku.js';
import type { BotConfig, GlobalConfig, RepoInfo, TriageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Build triage prompt
// ---------------------------------------------------------------------------

function buildTriagePrompt(
  message: string,
  authorName: string,
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
From: ${authorName}
Content: ${message}

## Decision Rules
1. If the message asks for code work in a specific repo → repo_work
2. If the message is a general question, greeting, or status request → reply
3. If the message is not relevant to this bot → ignore
4. For repo_work: choose the best matching repo from Available Repositories
5. For repo_work: write a clear, actionable task description that claude can execute

## Output
Respond with ONLY a JSON object (no markdown fencing):
- repo_work: {"action":"repo_work","repoName":"<name>","repo":"<absolute_path>","task":"<detailed task description>"}
- reply: {"action":"reply","message":"<your response text>"}
- ignore: {"action":"ignore"}`;
}

// ---------------------------------------------------------------------------
// Parse triage response
// ---------------------------------------------------------------------------

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
  bot: BotConfig,
  botMemory: string,
  repos: RepoInfo[],
  global: GlobalConfig,
  otherBots: { id: string; name: string; discordUserId?: string }[],
): Promise<TriageResult> {
  const prompt = buildTriagePrompt(message, authorName, bot, botMemory, repos, global, otherBots);

  try {
    const output = await runHaiku(prompt);
    return parseTriageResponse(output);
  } catch (err) {
    console.error(`[triage:${bot.id}] Haiku error:`, err);
    // On triage failure, ignore to avoid broken responses
    return { action: 'ignore' };
  }
}
