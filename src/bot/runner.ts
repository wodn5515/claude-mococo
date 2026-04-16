import { Client, GatewayIntentBits, type Message, type TextBasedChannel, type TextChannel } from 'discord.js';
import {
  loadBotMemory,
  saveBotMemory,
  saveBotConfig,
  loadPersona,
  loadRepoSummaries,
  appendWorklog,
  listBotIds,
  loadBotConfig,
} from '../config.js';
import { triage } from '../triage/triage.js';
import { executeInRepo } from '../engine/claude-engine.js';
import { buildSystemPrompt } from './system-prompt.js';
import { extractMemoryUpdate, truncateForDiscord } from './post-process.js';
import { Scheduler } from './scheduler.js';
import type { BotConfig, GlobalConfig, TriageResult } from '../types.js';

// ---------------------------------------------------------------------------
// Bot runner
// ---------------------------------------------------------------------------

export async function createBotRunner(
  bot: BotConfig,
  global: GlobalConfig,
  discordToken: string,
): Promise<void> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let busy = false;
  let scheduler: Scheduler | null = null;

  client.on('ready', () => {
    console.log(`[${bot.name}] Connected to Discord as ${client.user?.tag}`);

    // Auto-save Discord user ID on first login
    if (client.user && !bot.discordUserId) {
      bot.discordUserId = client.user.id;
      const { id: _id, ...configWithoutId } = bot;
      saveBotConfig(bot.id, configWithoutId);
      console.log(`[${bot.name}] Saved Discord user ID: ${bot.discordUserId}`);
    }

    // Start scheduler if configured
    if (bot.schedule) {
      scheduler = new Scheduler(bot.schedule, bot.name, async (trigger) => {
        if (busy) {
          console.log(`[${bot.name}:scheduler] Skipping ${trigger} trigger — busy`);
          return;
        }
        busy = true;
        try {
          await handleScheduledTrigger(client, bot, global, trigger);
        } catch (err) {
          console.error(`[${bot.name}:scheduler] Error:`, err);
        } finally {
          busy = false;
          scheduler?.notifyTaskComplete();
        }
      });
      scheduler.start();
    }
  });

  client.on('messageCreate', async (message: Message) => {
    // Ignore own messages
    if (message.author.id === client.user?.id) return;

    // Ignore other bots' messages unless they mention this bot
    if (message.author.bot) {
      const mentionsMe = bot.discordUserId && message.content.includes(`<@${bot.discordUserId}>`);
      if (!mentionsMe) return;
    }

    // Channel restriction
    if (bot.channels && bot.channels.length > 0 && !bot.channels.includes(message.channelId)) return;

    // If not leader, only respond to direct @mentions
    if (!bot.isLeader) {
      const mentionsMe = bot.discordUserId && message.mentions.has(bot.discordUserId);
      if (!mentionsMe) return;
    }

    // Notify scheduler of activity (resets idle timer)
    scheduler?.notifyActivity();

    // Skip if busy
    if (busy) {
      console.log(`[${bot.name}] Busy, skipping message from ${message.author.username}`);
      await message.reply('작업 중입니다. 잠시 후 다시 시도해주세요.').catch(() => {});
      return;
    }

    busy = true;
    try {
      await handleMessage(message, bot, global);
    } catch (err) {
      console.error(`[${bot.name}] Error handling message:`, err);
      try {
        await message.reply(`Error: ${(err as Error).message}`);
      } catch { /* ignore reply failure */ }
    } finally {
      busy = false;
      scheduler?.notifyActivity(); // Reset idle after completing work too
    }
  });

  await client.login(discordToken);

  // Keep process alive
  process.on('SIGINT', () => {
    console.log(`\n[${bot.name}] Shutting down...`);
    scheduler?.stop();
    client.destroy();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Scheduled trigger handler (cron / idle)
// ---------------------------------------------------------------------------

async function handleScheduledTrigger(
  client: Client,
  bot: BotConfig,
  global: GlobalConfig,
  trigger: 'cron' | 'idle',
): Promise<void> {
  const persona = loadPersona(bot.id);
  const botMemory = loadBotMemory(bot.id);
  const repos = loadRepoSummaries(bot.allowedDirs);
  const otherBots = getOtherBots(bot.id);

  // Build a system message based on the trigger type
  const systemMessage = trigger === 'cron'
    ? `[자동 실행: 정기 점검] 너의 역할과 전문 분야에 맞는 작업을 수행해. 담당 레포를 분석하고, 발견한 내용을 보고해.`
    : `[자동 실행: 대기 중 자율 작업] 현재 대기 상태야. 너의 역할과 전문 분야에 맞게 담당 레포를 분석하고, 개선할 점이나 문제를 찾아서 보고해.`;

  console.log(`[${bot.name}] Scheduled trigger (${trigger}): starting triage`);

  const decision = await triage(systemMessage, 'system', bot, botMemory, repos, global, otherBots);
  console.log(`[${bot.name}] Triage: ${decision.action}${decision.action === 'repo_work' ? ` → ${decision.repoName}` : ''}`);

  if (decision.action === 'ignore') return;

  // Find the report channel
  const reportChannelId = bot.schedule?.reportChannel || bot.channels?.[0];
  const reportChannel = reportChannelId
    ? client.channels.cache.get(reportChannelId) as TextChannel | undefined
    : null;

  if (decision.action === 'reply') {
    if (reportChannel) {
      await sendToChannel(reportChannel, `[${trigger === 'cron' ? '정기 점검' : '자율 분석'}] ${decision.message}`);
    } else {
      console.log(`[${bot.name}] Scheduled reply (no channel): ${decision.message.slice(0, 200)}`);
    }
    return;
  }

  // repo_work
  const { repo, repoName, task } = decision;

  // Validate repo path
  if (!isPathAllowed(repo, bot.allowedDirs)) {
    console.warn(`[${bot.name}] Scheduled triage returned unauthorized path: ${repo}`);
    return;
  }

  const systemPrompt = buildSystemPrompt(bot, persona, botMemory, repoName, global);

  console.log(`[${bot.name}] Scheduled execution in ${repoName}: ${task.slice(0, 100)}`);
  const result = await executeInRepo(task, repo, systemPrompt, bot);

  // Post-process
  const memoryUpdate = extractMemoryUpdate(result.output);
  if (memoryUpdate) saveBotMemory(bot.id, memoryUpdate);

  // Append worklog
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const taskSummary = task.length > 100 ? task.slice(0, 100) + '...' : task;
  const resultSummary = result.output.length > 200 ? result.output.slice(0, 200) + '...' : result.output;
  appendWorklog(repoName, `- [${now}] **${bot.name}** (${trigger}): ${taskSummary}\n  Result: ${resultSummary}\n`);

  // Report to Discord
  const discordOutput = truncateForDiscord(result.output);
  if (reportChannel && discordOutput) {
    await sendToChannel(reportChannel, `[${trigger === 'cron' ? '정기 점검' : '자율 분석'}]\n${discordOutput}`);
  } else if (discordOutput) {
    console.log(`[${bot.name}] Scheduled result (no channel):\n${discordOutput.slice(0, 500)}`);
  }

  if (result.costUsd) {
    console.log(`[${bot.name}] Scheduled task cost: $${result.costUsd.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------------------
// Message handler (Discord-triggered)
// ---------------------------------------------------------------------------

async function handleMessage(
  message: Message,
  bot: BotConfig,
  global: GlobalConfig,
): Promise<void> {
  const content = message.content;
  const authorName = message.author.username;

  console.log(`[${bot.name}] Message from ${authorName}: ${content.slice(0, 100)}`);

  // Show typing indicator
  const channel = message.channel as TextBasedChannel & { sendTyping?: () => Promise<void> };
  if (channel.sendTyping) await channel.sendTyping();
  const typingInterval = setInterval(() => { channel.sendTyping?.().catch(() => {}); }, 8000);

  try {
    // Phase 1: Triage
    const botMemory = loadBotMemory(bot.id);
    const repos = loadRepoSummaries(bot.allowedDirs);
    const otherBots = getOtherBots(bot.id);

    const decision = await triage(content, authorName, bot, botMemory, repos, global, otherBots);
    console.log(`[${bot.name}] Triage: ${decision.action}${decision.action === 'repo_work' ? ` → ${decision.repoName}` : ''}`);

    if (decision.action === 'ignore') return;

    if (decision.action === 'reply') {
      await sendLongMessage(message, decision.message);
      return;
    }

    // Phase 2: Execution — repo_work
    const { repo, repoName, task } = decision;

    // Validate repo path is in allowed directories
    if (!isPathAllowed(repo, bot.allowedDirs)) {
      console.warn(`[${bot.name}] Triage returned unauthorized path: ${repo}`);
      await message.reply(`접근 권한이 없는 경로입니다: ${repo}`);
      return;
    }

    const persona = loadPersona(bot.id);
    const systemPrompt = buildSystemPrompt(bot, persona, botMemory, repoName, global);

    console.log(`[${bot.name}] Executing in ${repoName}: ${task.slice(0, 100)}`);
    const result = await executeInRepo(task, repo, systemPrompt, bot);

    // Post-process
    const memoryUpdate = extractMemoryUpdate(result.output);
    if (memoryUpdate) saveBotMemory(bot.id, memoryUpdate);

    // Append to worklog
    const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const taskSummary = task.length > 100 ? task.slice(0, 100) + '...' : task;
    const resultSummary = result.output.length > 200 ? result.output.slice(0, 200) + '...' : result.output;
    appendWorklog(repoName, `- [${now}] **${bot.name}**: ${taskSummary}\n  Result: ${resultSummary}\n`);

    // Send to Discord
    const discordOutput = truncateForDiscord(result.output);
    if (discordOutput) {
      await sendLongMessage(message, discordOutput);
    } else {
      await message.reply('(작업 완료, 출력 없음)');
    }

    if (result.costUsd) {
      console.log(`[${bot.name}] Cost: $${result.costUsd.toFixed(4)}`);
    }

  } finally {
    clearInterval(typingInterval);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a path is allowed.
 * Special: "*" in allowedDirs means any path is allowed.
 */
function isPathAllowed(repoPath: string, allowedDirs: string[]): boolean {
  if (allowedDirs.includes('*')) return true;
  return allowedDirs.some(d => repoPath === d || repoPath.startsWith(d + '/'));
}

function getOtherBots(currentBotId: string) {
  return listBotIds()
    .filter(id => id !== currentBotId)
    .map(id => {
      try {
        const cfg = loadBotConfig(id);
        return { id, name: cfg.name, discordUserId: cfg.discordUserId };
      } catch { return null; }
    })
    .filter((b): b is NonNullable<typeof b> => b !== null);
}

const DISCORD_MAX_LENGTH = 2000;

async function sendLongMessage(message: Message, content: string): Promise<void> {
  if (content.length <= DISCORD_MAX_LENGTH) {
    await message.reply(content);
    return;
  }

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIdx < DISCORD_MAX_LENGTH / 2) splitIdx = DISCORD_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i === 0) {
      await message.reply(chunks[i]);
    } else {
      await (message.channel as any).send(chunks[i]);
    }
  }
}

async function sendToChannel(channel: TextChannel, content: string): Promise<void> {
  if (content.length <= DISCORD_MAX_LENGTH) {
    await channel.send(content);
    return;
  }

  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      await channel.send(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIdx < DISCORD_MAX_LENGTH / 2) splitIdx = DISCORD_MAX_LENGTH;
    await channel.send(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
}
