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
// HR activity log — append chat messages for HR evaluation
// ---------------------------------------------------------------------------

export function appendHrActivityLog(workspacePath: string, entry: { ts: number; channelId: string; author: string; teamId: string; content: string }): void {
  try {
    const logDir = path.resolve(workspacePath, '.mococo/hr-logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'activity-log.jsonl');
    fs.appendFileSync(logFile, JSON.stringify({ ...entry, content: entry.content.slice(0, 500) }) + '\n');
  } catch (err) {
    console.warn('[hr-log] Failed to append:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Inbox helpers — append chat to a team's inbox file for memory processing
// ---------------------------------------------------------------------------

// cancelled 플래그로 timeout 후 task 실행을 방지하여 race condition 해결
interface InboxTask {
  fn: () => Promise<void>;
  cancelled: boolean;
}

const inboxWriteQueue: InboxTask[] = [];
let isProcessingInboxQueue = false;
let inboxQueueHead = 0;

async function processInboxWriteQueue() {
  if (isProcessingInboxQueue || inboxQueueHead >= inboxWriteQueue.length) return;
  isProcessingInboxQueue = true;

  try {
    while (inboxQueueHead < inboxWriteQueue.length) {
      const task = inboxWriteQueue[inboxQueueHead];
      inboxWriteQueue[inboxQueueHead] = null as any; // Release reference for GC
      inboxQueueHead++;
      if (task.cancelled) continue; // timeout으로 취소된 task 스킵 (실행 전 1차 확인)
      try {
        if (task.cancelled) continue; // 실행 직전 2차 확인 — timeout race condition 방지
        await task.fn();
      } catch (err) {
        console.error('[inbox-queue] Write failed:', err);
      }
    }
  } finally {
    isProcessingInboxQueue = false;
    // drain 완료 후 새 항목이 추가되었는지 확인하여 재처리
    if (inboxQueueHead < inboxWriteQueue.length) {
      processInboxWriteQueue();
    } else {
      // 완전히 비었을 때만 참조 해제
      inboxWriteQueue.length = 0;
      inboxQueueHead = 0;
    }
  }
}

export function appendToInbox(teamId: string, from: string, content: string, workspacePath: string, channelId: string) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      task.cancelled = true;
      reject(new Error(`[inbox-queue] Timed out writing to ${teamId} inbox`));
    }, 30_000);

    const task: InboxTask = {
      fn: async () => {
        if (task.cancelled || settled) return; // cancelled 플래그 이중 확인 — timeout race condition 방지
        try {
          const dir = path.resolve(workspacePath, '.mococo/inbox');
          fs.mkdirSync(dir, { recursive: true });
          const file = path.resolve(dir, `${teamId}.md`);
          const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
          await fs.promises.appendFile(file, `[${ts} #ch:${channelId}] ${from}: ${content}\n`);
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve();
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(err);
        }
      },
      cancelled: false,
    };

    inboxWriteQueue.push(task);
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
const MIN_TRAIL_LENGTH_FOR_DETECTION = 6;
const MIN_CYCLE_PERIOD = 2;
const MIN_REPEATS_FOR_PERIOD_2 = 3; // Stricter for A↔B to avoid false positives
const MIN_REPEATS_FOR_LONGER_PERIODS = 2;

function detectLoop(chain: ChainContext, nextTeamId: string): boolean {
  const trail = [...chain.recentPath, nextTeamId];
  const trailLen = trail.length;

  // Invariant: trailLen must equal recentPath.length + 1 (nextTeamId appended)
  if (trailLen !== chain.recentPath.length + 1) return false;

  if (trailLen < MIN_TRAIL_LENGTH_FOR_DETECTION) return false;

  const maxPeriod = Math.floor(trailLen / 2);
  for (let period = MIN_CYCLE_PERIOD; period <= maxPeriod; period++) {
    const minRepeats = period === 2 ? MIN_REPEATS_FOR_PERIOD_2 : MIN_REPEATS_FOR_LONGER_PERIODS;
    const needed = period * minRepeats;
    if (trailLen < needed) continue;

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

export async function sendAsTeam(channelId: string, team: TeamConfig, content: string): Promise<boolean> {
  const client = teamClients.get(team.id);
  if (!client) {
    console.warn(`[sendAsTeam] No client for team ${team.name} (${team.id})`);
    return false;
  }

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) {
    console.warn(`[sendAsTeam] Channel ${channelId} not found for team ${team.name}`);
    return false;
  }

  const chunks = splitMessage(content, 1900);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
  return true;
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ---------------------------------------------------------------------------
// Bot creation + message routing
// ---------------------------------------------------------------------------

export async function createBots(config: TeamsConfig, env: EnvConfig): Promise<void> {
  const botUserIds = new Set<string>();

  // Dedup: prevent the same Discord message from being added to conversation
  // history twice (leader + non-leader both receive the same messageCreate event)
  const processedMsgIds = new Map<string, number>(); // msgId → timestamp
  const MAX_TRACKED_MSGS = 500;
  const MSG_EXPIRY_MS = 5 * 60_000; // 5분 경과 메시지 자동 만료

  function trimProcessedMsgs() {
    // 먼저 오래된 항목 시간 기반 제거
    const cutoff = Date.now() - MSG_EXPIRY_MS;
    for (const [id, ts] of processedMsgIds) {
      if (ts < cutoff) processedMsgIds.delete(id);
    }
    // 그래도 초과하면 FIFO 강제 제거 (Map 삽입 순서 이용)
    if (processedMsgIds.size <= MAX_TRACKED_MSGS) return;
    const overflow = processedMsgIds.size - MAX_TRACKED_MSGS;
    let removed = 0;
    for (const id of processedMsgIds.keys()) {
      if (removed >= overflow) break;
      processedMsgIds.delete(id);
      removed++;
    }
  }

  // 주기적 정리: 2분마다 만료 항목 제거
  // Runs for entire process lifetime — no cleanup needed
  setInterval(() => trimProcessedMsgs(), 2 * 60_000);

  // Forward hook events as team progress in Discord
  hookEvents.on('any', async (event) => {
    const team = event.mococo_team ? config.teams[event.mococo_team as string] : null;
    if (!team) return;

    if (event.hook_event_name === 'SubagentCompleted' && env.workChannelId) {
      await sendAsTeam(env.workChannelId, team,
        `Subtask done: **${event.task_subject ?? 'unknown'}** (${(event.teammate_name as string) ?? 'lead'})`
      ).catch(err => console.warn('[hook-events] sendAsTeam failed:', err instanceof Error ? err.message : err));
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
          } catch (err) {
            console.warn(`[client] Failed to sync discordUserId for ${team.name}: ${err}`);
          }
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

          const commands = [resetCmd.toJSON()];

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
          processedMsgIds.set(msg.id, Date.now());
          trimProcessedMsgs();
          addMessage(msg.channelId, humanMsg);
          appendHrActivityLog(config.workspacePath, {
            ts: Date.now(),
            channelId: msg.channelId,
            author: msg.author.displayName,
            teamId: 'human',
            content,
          });
        }

        // Leader reads every message — append to inbox for memory processing
        // Skip inbox when human directly mentions non-leader bots (direct command, no leader relay needed)
        const isHumanDirectToNonLeader = msg.author.id === config.humanDiscordId && mentionsOtherBot;
        if (!isHumanDirectToNonLeader) {
          await appendToInbox(team.id, msg.author.displayName, content, config.workspacePath, msg.channelId).catch(() => {});
        }

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
          processedMsgIds.set(msg.id, Date.now());
          trimProcessedMsgs();
          addMessage(msg.channelId, humanMsg);
          appendHrActivityLog(config.workspacePath, {
            ts: Date.now(),
            channelId: msg.channelId,
            author: msg.author.displayName,
            teamId: 'human',
            content,
          });
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
  }, env.workChannelId || env.memberTrackingChannelId);

  // Leader startup message — notify channel and invoke leader for memory cleanup
  const startupLeader = Object.values(config.teams).find(t => t.isLeader);
  const startupChannelId = env.workChannelId || env.memberTrackingChannelId;
  if (startupLeader && startupChannelId) {
    // Delay to ensure all bots are ready and background tasks initialized
    setTimeout(async () => {
      try {
        // Read leader's short-term memory once for pending tasks & in-progress
        const shortTermPath = path.resolve(config.workspacePath, '.mococo/memory', startupLeader.id, 'short-term.md');
        let pendingSummary = '';
        let inProgressSummary = '';
        try {
          const stm = fs.readFileSync(shortTermPath, 'utf-8');

          const pendingMatch = stm.match(/###\s*대기\s*항목\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
          if (pendingMatch) {
            const lines = pendingMatch[1].split('\n').filter(l => /^\s*-\s+.+/.test(l));
            if (lines.length > 0) {
              pendingSummary = `\n\n**대기 항목 (${lines.length}건):**\n${lines.join('\n')}`;
            }
          }

          const progressMatch = stm.match(/###\s*진행중\s*작업\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
          if (progressMatch) {
            const lines = progressMatch[1].split('\n').filter(l => /^\s*-\s+.+/.test(l));
            if (lines.length > 0) {
              inProgressSummary = `\n\n**진행중 작업 (${lines.length}건):**\n${lines.join('\n')}`;
            }
          }
        } catch { /* no short-term memory yet */ }

        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
        const startupContent = `🔄 **시스템 재시작 완료** (${now} KST)${inProgressSummary}${pendingSummary}\n\n메모리 상태를 정리하겠습니다.`;

        const systemMsg: ConversationMessage = {
          teamId: 'system',
          teamName: 'System',
          content: `[시스템 재시작] 봇이 재시작되었습니다. 메모리 상태를 점검하고, 대기중 작업을 확인한 후, 채널에 상태 정리 메시지를 출력하세요.`,
          timestamp: new Date(),
          mentions: [startupLeader.id],
        };

        await sendAsTeam(startupChannelId, startupLeader, startupContent).catch(err =>
          console.warn('[startup] sendAsTeam failed:', err instanceof Error ? err.message : err),
        );
        addMessage(startupChannelId, systemMsg);
        handleTeamInvocation(startupLeader, systemMsg, startupChannelId, config, env, newChain());
        console.log('[startup] Leader startup message sent and invocation triggered');
      } catch (err) {
        console.error(`[startup] Failed to send startup message: ${err}`);
      }
    }, 5_000); // 5 second delay after all bots ready
  }
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
    if (finalOutput) {
      appendHrActivityLog(config.workspacePath, {
        ts: Date.now(),
        channelId,
        author: team.name,
        teamId: team.id,
        content: finalOutput,
      });
    }

    // Write episode (await — must complete before markFree to prevent race with compactEpisodes)
    await writeEpisode(
      team.id, team.name, channelId, triggerMsg, result.output,
      mentionedTeams.map(t => t.id), config.workspacePath,
    ).catch(err => console.error(`[episode] ${err}`));

    // Size-based consolidation trigger
    checkSizeBasedConsolidation(team.id, team.name, config);

    // Resolve any pending dispatch records (this team reported back)
    ledger.resolve(team.id, mentionedTeams.map(t => t.id));

    // ---------------------------------------------------------------------------
    // Centralized dispatch: ONLY the leader dispatches to other teams.
    // Non-leader output with mentions is routed to the leader's inbox so the
    // leader can decide whether (and when) to invoke the mentioned teams.
    // ---------------------------------------------------------------------------
    if (finalOutput) {
      if (team.isLeader) {
        // Leader dispatches directly to mentioned teams
        dispatchMentionedTeams(finalOutput, result.output, team, channelId, config, env, chain);
      } else {
        // Non-leader: route mentions to leader inbox for centralized dispatch
        const mentionedInOutput = findMentionedTeams(result.output, config);
        const nonSelfMentions = mentionedInOutput.filter(
          t => t.id !== team.id && t.discordUserId !== config.humanDiscordId,
        );
        if (nonSelfMentions.length > 0) {
          const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
          if (leaderTeam) {
            appendToInbox(
              leaderTeam.id,
              team.name,
              finalOutput.slice(0, 500),
              config.workspacePath,
              channelId,
            ).catch(() => {});
          }
          // Record and auto-resolve in ledger (non-leader report, no follow-up needed)
          for (const target of nonSelfMentions) {
            if (target.isLeader) {
              const rec = ledger.record(chain.chainId, team.id, target.id, channelId, finalOutput.slice(0, 200));
              ledger.resolveById(rec.id);
            }
          }
        }
      }
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
// Centralized dispatch — leader-only: invoke mentioned teams from leader output
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
    if (target.id === sourceTeam.id) continue;
    if (target.discordUserId === config.humanDiscordId) continue;

    if (isQueued(target.id)) {
      console.log(`[dispatch] Skip ${target.name} — already queued`);
      continue;
    }

    if (detectLoop(chain, target.id)) {
      const trail = [...chain.recentPath, target.id];
      console.log(`[dispatch] Loop detected in chain ${trail.slice(-6).join('→')}, stopping dispatch to ${target.name}`);
      continue;
    }

    if (chain.totalInvocations >= chain.maxBudget) {
      console.log(`[dispatch] Chain budget exhausted (${chain.maxBudget}), stopping`);
      break;
    }

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

    handleTeamInvocation(target, triggerMsg, channelId, config, env, nextChain);
  }
}
