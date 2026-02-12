import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  type GuildMember, type TextChannel, type Message, type ChatInputCommandInteraction,
} from 'discord.js';
import { routeMessage, findMentionedTeams } from './router.js';
import { invokeTeam } from '../teams/invoker.js';
import { addMessage, getRecentConversation } from '../teams/context.js';
import { isBusy, isQueued, markBusy, markFree, waitForFree, getStatus } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { hookEvents } from '../server/hook-receiver.js';
import { processDiscordCommands, stripMemoryBlocks, ResourceRegistry } from './discord-commands.js';
import { startInboxCompactor } from './inbox-compactor.js';
import { startMemoryConsolidator, checkSizeBasedConsolidation } from './memory-consolidator.js';
import { startImprovementScanner } from './improvement-scanner.js';
import { writeEpisode } from './episode-writer.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage, ChainContext } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHAIN_BUDGET = 20;

// Map teamId → their Discord client (so teams can send messages as themselves)
export const teamClients = new Map<string, Client>();

// ---------------------------------------------------------------------------
// Inbox helpers — append chat to a team's inbox file for memory processing
// ---------------------------------------------------------------------------

const inboxWriteQueue: Array<() => Promise<void>> = [];
let isProcessingInboxQueue = false;

async function processInboxWriteQueue() {
  if (isProcessingInboxQueue || inboxWriteQueue.length === 0) return;
  isProcessingInboxQueue = true;

  while (inboxWriteQueue.length > 0) {
    const task = inboxWriteQueue.shift()!;
    try {
      await task();
    } catch (err) {
      console.error('[inbox-queue] Write failed:', err);
    }
  }

  isProcessingInboxQueue = false;
}

export function appendToInbox(teamId: string, from: string, content: string, workspacePath: string, channelId: string) {
  return new Promise<void>((resolve, reject) => {
    inboxWriteQueue.push(async () => {
      try {
        const dir = path.resolve(workspacePath, '.mococo/inbox');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.resolve(dir, `${teamId}.md`);
        const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
        await fs.promises.appendFile(file, `[${ts} #ch:${channelId}] ${from}: ${content}\n`);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
    processInboxWriteQueue();
  });
}

export function clearInbox(teamId: string, workspacePath: string) {
  const file = path.resolve(workspacePath, '.mococo/inbox', `${teamId}.md`);
  try { fs.unlinkSync(file); } catch {}
}

// ---------------------------------------------------------------------------
// Chain helpers — prevent infinite bot-to-bot loops
// ---------------------------------------------------------------------------

export function newChain(): ChainContext {
  return {
    chainId: crypto.randomUUID(),
    totalInvocations: 0,
    maxBudget: DEFAULT_CHAIN_BUDGET,
    recentPath: [],
  };
}

/**
 * Detect cyclic loop in the dispatch chain.
 *
 * Checks whether the tail of the path repeats a fixed-length cycle:
 *   - Period 2 (A↔B):   requires 3 consecutive repeats (6 elements)
 *   - Period 3+ (A→B→C→…): requires 2 consecutive repeats
 *
 * Examples:
 *   [A,B,A,B,A,B]       → period 2, 3 reps → true
 *   [A,B,C,A,B,C]       → period 3, 2 reps → true
 *   [A,B,C,A,B]         → period 3, < 2 reps → false (not enough data)
 *   [A,B,C,D,E,F]       → no repeating cycle → false
 */
function detectLoop(chain: ChainContext, nextTeamId: string): boolean {
  const trail = [...chain.recentPath, nextTeamId];
  if (trail.length < 4) return false;

  // Try cycle periods from 2 up to half the trail length
  const maxPeriod = Math.floor(trail.length / 2);
  for (let period = 2; period <= maxPeriod; period++) {
    // Period 2: strict — require 3 reps (6 elements) to avoid false positives
    // Period 3+: 2 reps is sufficient evidence of a cycle
    const minRepeats = period === 2 ? 3 : 2;
    const needed = period * minRepeats;
    if (trail.length < needed) continue;

    const tail = trail.slice(-needed);
    const cycle = tail.slice(0, period);

    let match = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== cycle[i % period]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Member tracking
// ---------------------------------------------------------------------------

function writeMemberList(members: Map<string, string>, workspacePath: string) {
  const dir = path.resolve(workspacePath, '.mococo');
  fs.mkdirSync(dir, { recursive: true });
  const membersPath = path.resolve(dir, 'members.md');
  const lines = Array.from(members.entries())
    .map(([id, name]) => `- ${name} (${id})`)
    .join('\n');
  fs.writeFileSync(membersPath, lines + '\n');
}

async function syncMemberList(client: Client, workspacePath: string) {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const fetched = await guild.members.fetch();
  const members = new Map<string, string>();
  for (const [id, m] of fetched) {
    members.set(id, m.displayName || m.user.username);
  }
  writeMemberList(members, workspacePath);
  console.log(`[member-tracking] Synced ${members.size} members`);
}

function updateMemberTracking(
  action: 'join' | 'leave',
  member: GuildMember,
  workspacePath: string,
) {
  const membersPath = path.resolve(workspacePath, '.mococo/members.md');
  const members = new Map<string, string>();
  try {
    const content = fs.readFileSync(membersPath, 'utf-8');
    for (const line of content.split('\n')) {
      const m = line.match(/^- (.+?) \((\d+)\)$/);
      if (m) members.set(m[2], m[1]);
    }
  } catch {}

  const displayName = member.displayName || member.user.username;
  if (action === 'join') {
    members.set(member.id, displayName);
  } else {
    members.delete(member.id);
  }

  writeMemberList(members, workspacePath);
  console.log(`[member-tracking] ${action}: ${displayName} (${member.id})`);
}

// ---------------------------------------------------------------------------
// Discord helpers
// ---------------------------------------------------------------------------

const registry = new ResourceRegistry();

export async function sendAsTeam(channelId: string, team: TeamConfig, content: string) {
  const client = teamClients.get(team.id);
  if (!client) return;

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  const chunks = splitMessage(content, 1900);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Bot creation + message routing
// ---------------------------------------------------------------------------

export async function createBots(config: TeamsConfig, env: EnvConfig): Promise<void> {
  const botUserIds = new Set<string>();

  // Dedup: prevent the same Discord message from being added to conversation
  // history twice (leader + non-leader both receive the same messageCreate event)
  const processedMsgIds = new Set<string>();
  setInterval(() => processedMsgIds.clear(), 10 * 60_000);

  // Forward hook events as team progress in Discord
  hookEvents.on('any', async (event) => {
    const team = event.mococo_team ? config.teams[event.mococo_team as string] : null;
    if (!team) return;

    if (event.hook_event_name === 'SubagentCompleted' && env.workChannelId) {
      await sendAsTeam(env.workChannelId, team,
        `Subtask done: **${event.task_subject ?? 'unknown'}** (${(event.teammate_name as string) ?? 'lead'})`
      ).catch(() => {});
    }
  });

  for (const team of Object.values(config.teams)) {
    if (!team.discordToken) {
      console.warn(`Team ${team.name} has no Discord token (${team.id.toUpperCase()}_DISCORD_TOKEN) — skipping`);
      continue;
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        ...(team.isLeader ? [GatewayIntentBits.GuildMembers] : []),
      ],
    });

    client.on('clientReady', async () => {
      if (client.user) {
        botUserIds.add(client.user.id);
        if (team.discordUserId !== client.user.id) {
          team.discordUserId = client.user.id;
          try {
            const teamsJsonPath = path.resolve(config.workspacePath, 'teams.json');
            const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));
            if (raw.teams[team.id]) {
              raw.teams[team.id].discordUserId = client.user.id;
              fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');
            }
          } catch {}
        }
        console.log(`  ${team.name} bot online as @${client.user.tag}`);

        if (team.isLeader) {
          syncMemberList(client, config.workspacePath).catch(() => {});
        }

        // Register slash commands (/reset)
        try {
          const resetCmd = new SlashCommandBuilder()
            .setName('reset')
            .setDescription('메모리 공장초기화 (long-term, short-term, episodes 삭제)');

          // Leader gets a team option to reset any team
          if (team.isLeader) {
            const teamChoices = [
              { name: '전체 (all)', value: 'all' },
              ...Object.values(config.teams).map(t => ({ name: t.name, value: t.id })),
            ];
            resetCmd.addStringOption(opt =>
              opt.setName('team')
                .setDescription('초기화할 팀 (미선택 시 전체)')
                .addChoices(...teamChoices),
            );
          }

          const restartCmd = new SlashCommandBuilder()
            .setName('restart')
            .setDescription('봇 프로세스 재시작 (코드 변경 적용)');

          const commands = [resetCmd.toJSON(), restartCmd.toJSON()];

          const rest = new REST().setToken(team.discordToken);
          const guildId = client.guilds.cache.first()?.id;
          if (guildId) {
            // Guild command: 즉시 반영 (global은 최대 1시간 대기)
            await rest.put(
              Routes.applicationGuildCommands(client.user.id, guildId),
              { body: commands },
            );
            console.log(`  ${team.name}: slash commands registered (guild: ${guildId})`);
          } else {
            console.warn(`  ${team.name}: No guild found, skipping slash command registration`);
          }
        } catch (err) {
          console.error(`  ${team.name}: Failed to register slash commands:`, err);
        }
      }
    });

    // Handle /reset slash command interaction
    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'reset') return;

      // Permission check: humanDiscordId only
      if (config.humanDiscordId && interaction.user.id !== config.humanDiscordId) {
        await interaction.reply({ content: '메모리 초기화는 회장님만 실행할 수 있습니다.', ephemeral: true });
        return;
      }

      if (team.isLeader) {
        const target = interaction.options.getString('team') ?? 'all';

        if (target === 'all') {
          const results: string[] = [];
          for (const t of Object.values(config.teams)) {
            const cleared = resetTeamMemory(t.id, config.workspacePath);
            results.push(`**${t.name}**: ${cleared.length > 0 ? cleared.join(', ') + ' 삭제' : '(비어있음)'}`);
          }
          await interaction.reply(`전체 팀 메모리 초기화 완료:\n${results.join('\n')}`);
        } else {
          const t = config.teams[target];
          if (!t) {
            await interaction.reply({ content: `팀을 찾을 수 없습니다: ${target}`, ephemeral: true });
            return;
          }
          const cleared = resetTeamMemory(t.id, config.workspacePath);
          await interaction.reply(`**${t.name}** 메모리 초기화 완료: ${cleared.length > 0 ? cleared.join(', ') + ' 삭제' : '(이미 비어있음)'}`);
        }
      } else {
        // Non-leader: reset own memory
        const cleared = resetTeamMemory(team.id, config.workspacePath);
        await interaction.reply(`**${team.name}** 메모리 초기화 완료: ${cleared.length > 0 ? cleared.join(', ') + ' 삭제' : '(이미 비어있음)'}`);
      }
    });

    // Handle /restart slash command interaction
    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'restart') return;

      // Permission check: humanDiscordId only
      if (config.humanDiscordId && interaction.user.id !== config.humanDiscordId) {
        await interaction.reply({ content: '재시작은 회장님만 실행할 수 있습니다.', ephemeral: true });
        return;
      }

      await interaction.reply('봇을 재시작합니다... 잠시 후 자동으로 복귀합니다.');

      // Give Discord time to send the reply, then exit.
      // launchd (KeepAlive: true) will restart the process automatically.
      setTimeout(() => process.exit(0), 1500);
    });

    // Member join/leave tracking (leader only)
    if (team.isLeader && env.memberTrackingChannelId) {
      client.on('guildMemberAdd', async (member: GuildMember) => {
        updateMemberTracking('join', member, config.workspacePath);

        const isMococo = Object.values(config.teams).some(
          t => t.discordUserId === member.id,
        );
        if (isMococo) {
          const channelId = env.memberTrackingChannelId!;
          const displayName = member.displayName || member.user.username;
          const triggerMsg: ConversationMessage = {
            teamId: 'system',
            teamName: 'System',
            content: `[신규 모코코 입장] ${displayName} (<@${member.id}>) 님이 서버에 참가했습니다. 환영 인사를 진행해주세요.`,
            timestamp: new Date(),
            mentions: [team.id],
          };
          addMessage(channelId, triggerMsg);
          handleTeamInvocation(team, triggerMsg, channelId, config, env, newChain());
        }
      });

      client.on('guildMemberRemove', async (member) => {
        updateMemberTracking('leave', member as GuildMember, config.workspacePath);
      });
    }

    // Message handler
    client.on('messageCreate', async (msg: Message) => {
      if (team.channels && team.channels.length > 0 && !team.channels.includes(msg.channelId)) return;
      if (botUserIds.has(msg.author.id)) return;
      if (msg.author.bot) return;

      const content = msg.content.trim();
      if (!content) return;

      if (team.isLeader) {
        if (await handleAdminCommand(content, msg, config)) return;

        const mentionsOtherBot = Object.values(config.teams).some(t =>
          !t.isLeader && t.discordUserId && msg.mentions.users.has(t.discordUserId)
        );

        const humanMsg: ConversationMessage = {
          teamId: 'human',
          teamName: msg.author.displayName,
          discordId: msg.author.id,
          content,
          timestamp: new Date(),
          mentions: findMentionedTeams(content, config).map(t => t.id),
        };
        if (!processedMsgIds.has(msg.id)) {
          processedMsgIds.add(msg.id);
          addMessage(msg.channelId, humanMsg);
        }

        // Leader reads every message — append to inbox for memory processing
        await appendToInbox(team.id, msg.author.displayName, content, config.workspacePath, msg.channelId).catch(() => {});

        if (mentionsOtherBot) return;

        const targetTeams = routeMessage(content, true, config);
        const chain = newChain();
        for (const target of targetTeams) {
          handleTeamInvocation(target, humanMsg, msg.channelId, config, env, chain);
        }
      }
      // Non-leader bots: only respond if this bot is @mentioned in Discord
      else if (msg.mentions.users.has(client.user?.id ?? '')) {
        const humanMsg: ConversationMessage = {
          teamId: 'human',
          teamName: msg.author.displayName,
          discordId: msg.author.id,
          content,
          timestamp: new Date(),
          mentions: [team.id],
        };
        if (!processedMsgIds.has(msg.id)) {
          processedMsgIds.add(msg.id);
          addMessage(msg.channelId, humanMsg);
        }
        handleTeamInvocation(team, humanMsg, msg.channelId, config, env, newChain());
      }
    });

    teamClients.set(team.id, client);
    await client.login(team.discordToken);
  }

  // Start periodic background tasks
  startInboxCompactor(config, env, handleTeamInvocation);
  startMemoryConsolidator(config);
  startImprovementScanner(config, (team, channelId, systemMessage) => {
    const triggerMsg: ConversationMessage = {
      teamId: 'system',
      teamName: 'System',
      content: systemMessage,
      timestamp: new Date(),
      mentions: [team.id],
    };
    addMessage(channelId, triggerMsg);
    handleTeamInvocation(team, triggerMsg, channelId, config, env, newChain());
  }, env.workChannelId);
}

// ---------------------------------------------------------------------------
// Memory reset — 공장초기화
// ---------------------------------------------------------------------------
// Discord 슬래시 커맨드: /reset
//   각 봇에서 실행하면 해당 봇의 메모리를 초기화.
//   리더 봇에서는 team 옵션으로 특정 팀 또는 all 선택 가능.
//
// 삭제 대상: long-term.md, short-term.md, episodes.jsonl
// 유지 대상: inbox, in-memory conversation history, persona prompt
//
// ⚠️ 회장님(humanDiscordId)만 실행 가능. 되돌릴 수 없음.
// ---------------------------------------------------------------------------

function resetTeamMemory(teamId: string, workspacePath: string): string[] {
  const memoryDir = path.resolve(workspacePath, '.mococo/memory', teamId);
  const cleared: string[] = [];

  for (const file of ['long-term.md', 'short-term.md', 'episodes.jsonl']) {
    const filePath = path.resolve(memoryDir, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        cleared.push(file);
      }
    } catch {}
  }

  return cleared;
}

// ---------------------------------------------------------------------------
// Admin commands
// ---------------------------------------------------------------------------

async function handleAdminCommand(
  content: string,
  msg: Message,
  config: TeamsConfig,
): Promise<boolean> {
  if (content === '!status') {
    const status = getStatus();
    const lines = Object.entries(config.teams).map(([id, t]) => {
      const s = status[id];
      const online = teamClients.has(t.id) ? 'online' : 'no token';
      return `- **${t.name}** [${t.engine}] (${online}): ${s?.busy ? `working (${s.task})` : 'idle'}`;
    });
    await msg.reply(lines.join('\n') || 'All teams idle.');
    return true;
  }

  if (content === '!teams') {
    const lines = Object.values(config.teams)
      .map(t => {
        const online = teamClients.has(t.id) ? 'online' : 'offline';
        return `- **${t.name}** [${t.engine}/${t.model}] (${online}) ${t.isLeader ? '— leader' : ''}`;
      })
      .join('\n');
    await msg.reply(lines);
    return true;
  }

  if (content === '!repos') {
    let repos: string[] = [];
    try {
      repos = fs.readdirSync(path.resolve(config.workspacePath, 'repos')).filter(f => f !== '.gitkeep');
    } catch {}
    await msg.reply(repos.map(r => `- **${r}**`).join('\n') || 'No repos linked.');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Core: Team invocation + reactive dispatch
// ---------------------------------------------------------------------------

export async function handleTeamInvocation(
  team: TeamConfig,
  triggerMsg: ConversationMessage,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
  chain: ChainContext = newChain(),
) {
  // If already queued, don't pile on — drop with inbox fallback for leader
  if (isQueued(team.id)) {
    console.log(`[${team.name}] Already queued, skipping duplicate invocation`);
    if (!team.isLeader) {
      await appendToInbox(
        Object.values(config.teams).find(t => t.isLeader)?.id ?? team.id,
        'System',
        `[큐 중복 방지] ${team.name} 호출 스킵됨 (이미 대기 중). 트리거: ${triggerMsg.content.slice(0, 100)}`,
        config.workspacePath,
        channelId,
      ).catch(() => {});
    }
    return;
  }

  if (isBusy(team.id)) {
    await waitForFree(team.id);
  }

  markBusy(team.id, triggerMsg.content.slice(0, 50));
  console.log(`[${team.name}] Invoking (chain: ${chain.totalInvocations}/${chain.maxBudget}, trigger: ${triggerMsg.content.slice(0, 80)})`);

  // Pre-read and atomically clear inbox for leader to prevent data loss.
  // Messages arriving during engine execution go to a fresh file and survive.
  let preloadedInbox: string | undefined;
  if (team.isLeader) {
    const inboxPath = path.resolve(config.workspacePath, '.mococo/inbox', `${team.id}.md`);
    try { preloadedInbox = fs.readFileSync(inboxPath, 'utf-8').trim(); } catch {}
    clearInbox(team.id, config.workspacePath);
  } else {
    // Non-leader: clear inbox to prevent unbounded growth
    clearInbox(team.id, config.workspacePath);
  }

  // Show typing indicator
  const typingClient = teamClients.get(team.id);
  const typingChannel = typingClient?.channels.cache.get(channelId) as TextChannel | undefined;
  await typingChannel?.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    typingChannel?.sendTyping().catch(() => {});
  }, 8_000);

  try {
    const conversation = getRecentConversation(channelId, config.conversationWindow);

    const result = await invokeTeam(team, {
      teamId: team.id,
      trigger: triggerMsg.teamId === 'human' ? 'human_message' : 'team_mention',
      message: triggerMsg,
      conversation,
      channelId,
    }, config, preloadedInbox);

    console.log(`[${team.name}] Done (output: ${result.output ? result.output.length + ' chars' : 'empty'}, cost: $${result.cost.toFixed(4)})`);

    // Strip memory/persona blocks
    let finalOutput = result.output;
    if (finalOutput) {
      finalOutput = stripMemoryBlocks(finalOutput, team.id, config.workspacePath);
    }

    // Process discord commands
    if (finalOutput) {
      const guildClient = teamClients.get(team.id);
      const guildChannel = guildClient?.channels.cache.get(channelId) as TextChannel | undefined;
      if (guildChannel?.guild) {
        finalOutput = await processDiscordCommands(finalOutput, {
          guild: guildChannel.guild,
          team,
          config,
          env,
          registry,
          channelId,
          teamClients,
          sendAsTeam,
        });
      }
    }

    // Send to Discord
    if (finalOutput) {
      await sendAsTeam(channelId, team, finalOutput);
    }

    // Record in conversation history
    const mentionedTeams = findMentionedTeams(result.output, config);
    const teamMsg: ConversationMessage = {
      teamId: team.id,
      teamName: team.name,
      content: finalOutput,
      timestamp: new Date(),
      mentions: mentionedTeams.map(t => t.id),
    };
    addMessage(channelId, teamMsg);

    // Write episode (await — must complete before markFree to prevent race with compactEpisodes)
    await writeEpisode(
      team.id, team.name, channelId, triggerMsg, result.output,
      mentionedTeams.map(t => t.id), config.workspacePath,
    ).catch(err => console.error(`[episode] ${err}`));

    // Size-based consolidation trigger
    checkSizeBasedConsolidation(team.id, team.name, config);

    // Resolve any pending dispatch records (this team reported back)
    ledger.resolve(team.id, mentionedTeams.map(t => t.id));

    // Reactive dispatch: invoke mentioned teams directly
    if (finalOutput) {
      dispatchMentionedTeams(finalOutput, result.output, team, channelId, config, env, chain);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${team.name}] Error: ${errorMsg}`);
    await sendAsTeam(channelId, team, `Error: ${errorMsg}`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
    markFree(team.id);
  }
}

// ---------------------------------------------------------------------------
// Reactive dispatch — bot output mentions → invoke those teams
// ---------------------------------------------------------------------------

function dispatchMentionedTeams(
  finalOutput: string,
  rawOutput: string,
  sourceTeam: TeamConfig,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
  chain: ChainContext,
): void {
  const mentioned = findMentionedTeams(rawOutput, config);

  for (const target of mentioned) {
    // Skip self
    if (target.id === sourceTeam.id) continue;

    // Skip human mentions (not a team to invoke)
    if (target.discordUserId === config.humanDiscordId) continue;

    // Skip if already queued
    if (isQueued(target.id)) {
      console.log(`[dispatch] Skip ${target.name} — already queued`);
      continue;
    }

    // Loop detection
    if (detectLoop(chain, target.id)) {
      const trail = [...chain.recentPath, target.id];
      console.log(`[dispatch] Loop detected in chain ${trail.slice(-6).join('→')}, stopping dispatch to ${target.name}`);
      continue;
    }

    // Budget check
    if (chain.totalInvocations >= chain.maxBudget) {
      console.log(`[dispatch] Chain budget exhausted (${chain.maxBudget}), stopping`);
      // Notify leader about budget exhaustion
      const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
      if (leaderTeam && sourceTeam.id !== leaderTeam.id) {
        appendToInbox(
          leaderTeam.id,
          'System',
          `[체인 예산 초과] ${sourceTeam.name}의 chain이 ${chain.maxBudget}회 invoke에 도달. 추가 dispatch 중단됨.`,
          config.workspacePath,
          channelId,
        ).catch(() => {});
      }
      break;
    }

    // Record in dispatch ledger
    ledger.record(chain.chainId, sourceTeam.id, target.id, channelId, finalOutput.slice(0, 200));

    const triggerMsg: ConversationMessage = {
      teamId: sourceTeam.id,
      teamName: sourceTeam.name,
      content: finalOutput,
      timestamp: new Date(),
      mentions: [target.id],
    };

    console.log(`[dispatch] ${sourceTeam.name} → ${target.name} (chain ${chain.totalInvocations + 1}/${chain.maxBudget})`);

    const nextChain: ChainContext = {
      chainId: chain.chainId,
      totalInvocations: chain.totalInvocations + 1,
      maxBudget: chain.maxBudget,
      recentPath: [...chain.recentPath.slice(-5), target.id],
    };

    // Fire and forget — don't await to allow parallel dispatches
    handleTeamInvocation(target, triggerMsg, channelId, config, env, nextChain);
  }
}
