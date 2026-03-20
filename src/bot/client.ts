import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  type GuildMember, type TextChannel, type Message, type ChatInputCommandInteraction,
} from 'discord.js';
import { atomicWriteSync } from '../utils/fs.js';
import { routeMessage, findMentionedTeams } from './router.js';
import { invokeTeam } from '../teams/invoker.js';
import { addMessage, getRecentConversation } from '../teams/context.js';
import { isBusy, isQueued, markBusy, markFree, waitForFree, getStatus } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { hookEvents } from '../server/hook-receiver.js';
import { processDiscordCommands, stripMemoryBlocks, ResourceRegistry } from './discord-commands.js';
import { appendToInbox, clearInbox } from './inbox-writer.js';
import { startInboxCompactor, markDirectInvoke } from './inbox-compactor.js';
import { updateStress, detectPositiveFeedback, shouldSendLevel3Alert, markLevel3AlertSent } from './stress-tracker.js';
import { startMemoryConsolidator, checkSizeBasedConsolidation } from './memory-consolidator.js';
import { startImprovementScanner } from './improvement-scanner.js';
import { writeEpisode } from './episode-writer.js';
import { handleDashboardCommand, saveTaskMetrics } from './dashboard.js';
import { verifyPRStatuses } from '../utils/github-status.js';
import { initTaskPersistence } from './heartbeat-tasks.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage, ChainContext } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CHAIN_BUDGET = 20;
const MAX_TIMEOUT_CONTINUATIONS = 3; // Maximum re-invocations on timeout

// Map teamId → their Discord client (so teams can send messages as themselves)
export const teamClients = new Map<string, Client>();

// Module-level interval tracking to prevent leaks on createBots() re-invocation
let _msgCleanupInterval: ReturnType<typeof setInterval> | null = null;
let _sigintHandler: (() => void) | null = null;
let _sigtermHandler: (() => void) | null = null;

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

// Safety-net: strip any internal command blocks that should never reach Discord
const INTERNAL_BLOCK_PATTERNS = [
  /(?:```\s*\n?)?(?:\[discord:edit-memory\]\s*\n)?-{3,}\s*\n?\s*MEMORY\s*-{3,}\s*\n[\s\S]*?\n\s*-{3,}\s*\n?\s*END-MEMORY\s*-{3,}(?:\s*\n?```)?/g,
  /(?:```\s*\n?)?(?:\[discord:edit-long-memory\]\s*\n)?-{3,}\s*\n?\s*LONG-MEMORY\s*-{3,}\s*\n[\s\S]*?\n\s*-{3,}\s*\n?\s*END-LONG-MEMORY\s*-{3,}(?:\s*\n?```)?/g,
  /(?:```\s*\n?)?(?:\[discord:edit-persona\]\s*\n)?-{3,}\s*\n?\s*PERSONA\s*-{3,}\s*\n[\s\S]*?\n\s*-{3,}\s*\n?\s*END-PERSONA\s*-{3,}(?:\s*\n?```)?/g,
];

function sanitizeForDiscord(text: string): string {
  let result = text;
  for (const pattern of INTERNAL_BLOCK_PATTERNS) {
    result = result.replace(pattern, '');
  }
  return result.replace(/\n{3,}/g, '\n\n').trim();
}

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

  const sanitized = sanitizeForDiscord(content);
  if (!sanitized) return true;

  const chunks = splitMessage(sanitized, 1900);
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
    if (splitAt < 1) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    // 개행 위치에서 분할 시 개행 문자를 소비하여 다음 청크 앞의 빈 줄 방지
    const skipNewline = splitAt < remaining.length && remaining[splitAt] === '\n';
    remaining = remaining.slice(skipNewline ? splitAt + 1 : splitAt);
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

  /** Lightweight: only evict when size exceeds MAX — called on every message add. */
  function evictOldestIfNeeded() {
    if (processedMsgIds.size <= MAX_TRACKED_MSGS) return;
    // 먼저 expired 항목 제거 시도 (size 이하로 줄어들면 조기 종료)
    const cutoff = Date.now() - MSG_EXPIRY_MS;
    for (const [id, ts] of processedMsgIds) {
      if (processedMsgIds.size <= MAX_TRACKED_MSGS) break;
      if (ts < cutoff) processedMsgIds.delete(id);
    }
    // 여전히 초과면 FIFO 강제 제거 (Map 삽입 순서 이용)
    if (processedMsgIds.size <= MAX_TRACKED_MSGS) return;
    const overflow = processedMsgIds.size - MAX_TRACKED_MSGS;
    let removed = 0;
    for (const id of processedMsgIds.keys()) {
      if (removed >= overflow) break;
      processedMsgIds.delete(id);
      removed++;
    }
  }

  /** Full sweep: remove all expired entries — called periodically by setInterval. */
  function cleanupExpiredEntries() {
    const cutoff = Date.now() - MSG_EXPIRY_MS;
    for (const [id, ts] of processedMsgIds) {
      if (ts < cutoff) processedMsgIds.delete(id);
    }
  }

  // Clear previous cleanup interval if createBots() is called again (hot reload)
  if (_msgCleanupInterval !== null) {
    clearInterval(_msgCleanupInterval);
  }
  // Remove previous signal handlers to prevent accumulation on re-invocation
  if (_sigintHandler) {
    process.removeListener('SIGINT', _sigintHandler);
    _sigintHandler = null;
  }
  if (_sigtermHandler) {
    process.removeListener('SIGTERM', _sigtermHandler);
    _sigtermHandler = null;
  }

  // 주기적 정리: 2분마다 만료 항목 전체 제거
  _msgCleanupInterval = setInterval(() => {
    try {
      cleanupExpiredEntries();
    } catch (err) {
      console.error('[processedMsgIds] Periodic cleanup failed:', err);
    }
  }, 2 * 60_000);

  // Cleanup on process exit to prevent leaked timers
  const clearCleanupInterval = () => {
    if (_msgCleanupInterval !== null) {
      clearInterval(_msgCleanupInterval);
      _msgCleanupInterval = null;
    }
  };
  _sigintHandler = clearCleanupInterval;
  _sigtermHandler = clearCleanupInterval;
  process.once('SIGINT', _sigintHandler);
  process.once('SIGTERM', _sigtermHandler);

  // Forward hook events as team progress in Discord
  // Remove previous listeners to prevent accumulation on repeated createBots() calls
  hookEvents.removeAllListeners('any');
  hookEvents.on('any', async (event) => {
    try {
      const team = event.mococo_team ? config.teams[event.mococo_team as string] : null;
      if (!team) return;

      if (event.hook_event_name === 'SubagentCompleted' && env.workChannelId) {
        await sendAsTeam(env.workChannelId, team,
          `Subtask done: **${event.task_subject ?? 'unknown'}** (${(event.teammate_name as string) ?? 'lead'})`
        ).catch(err => console.warn('[hook-events] sendAsTeam failed:', err instanceof Error ? err.message : err));
      }
    } catch (err) {
      console.error('[hook-events] Unexpected error:', err);
    }
  });

  for (const team of Object.values(config.teams)) {
    if (!team.discordToken) {
      console.warn(`Team ${team.name} has no Discord token (${team.id.toUpperCase()}_DISCORD_TOKEN) — skipping`);
      continue;
    }

    // Destroy previous client instance to prevent resource leaks (listener accumulation, zombie WebSocket)
    const existingClient = teamClients.get(team.id);
    if (existingClient) {
      console.log(`[${team.name}] Destroying previous client instance before recreation`);
      existingClient.removeAllListeners();
      try {
        existingClient.destroy();
      } catch (err) {
        console.error(`[${team.name}] Failed to destroy old client:`, err);
      }
      teamClients.delete(team.id);
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
              atomicWriteSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');
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
      try {
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
      } catch (err) {
        console.error(`[${team.name}] interactionCreate error:`, err);
      }
    });

    // Member join/leave tracking (leader only)
    if (team.isLeader && env.memberTrackingChannelId) {
      client.on('guildMemberAdd', async (member: GuildMember) => {
        try {
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
        } catch (err) {
          console.error(`[${team.name}] guildMemberAdd error:`, err);
        }
      });

      client.on('guildMemberRemove', async (member) => {
        try {
          updateMemberTracking('leave', member as GuildMember, config.workspacePath);
        } catch (err) {
          console.error(`[${team.name}] guildMemberRemove error:`, err);
        }
      });
    }

    // Message handler
    client.on('messageCreate', async (msg: Message) => {
      try {
        if (team.channels && team.channels.length > 0 && !team.channels.includes(msg.channelId)) return;
        if (botUserIds.has(msg.author.id)) return;
        if (msg.author.bot) return;

        const content = msg.content.trim();
        if (!content) return;

        if (team.isLeader) {
          // Claim message atomically (synchronous check+set before any await)
          // to prevent duplicate processing across leader/non-leader handlers (#50).
          // Node.js single-threaded event loop guarantees no interleaving between
          // has() and set() — the second handler always sees the claimed msgId.
          const isNewMsg = !processedMsgIds.has(msg.id);
          if (isNewMsg) {
            processedMsgIds.set(msg.id, Date.now());
            evictOldestIfNeeded();
          }

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
          if (isNewMsg) {
            addMessage(msg.channelId, humanMsg);
          }

          // Leader reads every message — append to inbox for memory processing
          // Skip inbox when human directly mentions non-leader bots (direct command, no leader relay needed)
          const isHumanDirectToNonLeader = msg.author.id === config.humanDiscordId && mentionsOtherBot;
          if (isNewMsg && !isHumanDirectToNonLeader) {
            await appendToInbox(team.id, msg.author.displayName, content, config.workspacePath, msg.channelId).catch(() => {});
          }

          if (mentionsOtherBot) return;

          // Skip routing/invocation if message was already claimed (duplicate event) (#50)
          if (!isNewMsg) return;

          // Positive feedback detection — update stress for all teams
          if (detectPositiveFeedback(content)) {
            for (const t of Object.values(config.teams)) {
              updateStress(config.workspacePath, t.id, 'positive_feedback', t.stressProfile);
            }
          }

          const targetTeams = routeMessage(content, true, config);
          // Signal direct invoke to suppress inbox watcher's redundant invocation (#48)
          if (targetTeams.some(t => t.isLeader)) {
            markDirectInvoke();
          }
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
            evictOldestIfNeeded();
            addMessage(msg.channelId, humanMsg);
          }
          handleTeamInvocation(team, humanMsg, msg.channelId, config, env, newChain());
        }
      } catch (err) {
        console.error(`[${team.name}] messageCreate error:`, err);
      }
    });

    teamClients.set(team.id, client);
    try {
      await client.login(team.discordToken);
    } catch (err) {
      console.error(`[${team.name}] Login failed:`, err);
      client.removeAllListeners();
      try { client.destroy(); } catch { /* ignore destroy errors */ }
      teamClients.delete(team.id);
    }
  }

  // Restore persisted runtime tasks before starting background tasks
  initTaskPersistence(config.workspacePath);

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

  // Leader startup message — verify actual state, then invoke leader for memory update
  const startupLeader = Object.values(config.teams).find(t => t.isLeader);
  const startupChannelId = env.workChannelId || env.memberTrackingChannelId;
  if (startupLeader && startupChannelId) {
    // Delay to ensure all bots are ready and background tasks initialized
    setTimeout(async () => {
      try {
        // 1. Check actual GitHub PR statuses referenced in ALL team memories
        const teamIds = Object.keys(config.teams);
        const { report: prStatusReport } = await verifyPRStatuses(config.workspacePath, teamIds);

        // 2. Read leader's short-term memory for pending tasks & in-progress
        const shortTermPath = path.resolve(config.workspacePath, '.mococo/memory', startupLeader.id, 'short-term.md');
        let pendingSummary = '';
        let inProgressSummary = '';
        try {
          const stm = fs.readFileSync(shortTermPath, 'utf-8');

          const pendingMatch = stm.match(/###\s*대기\s*항목\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
          if (pendingMatch) {
            const lines = pendingMatch[1].split('\n').filter(l => /^\s*-\s+.+/.test(l));
            if (lines.length > 0) {
              pendingSummary = `\n\n**대기 항목 — 메모리 기준 (${lines.length}건):**\n${lines.join('\n')}`;
            }
          }

          const progressMatch = stm.match(/###\s*진행중\s*작업\s*\n([\s\S]*?)(?=\n###|\n##|$)/);
          if (progressMatch) {
            const lines = progressMatch[1].split('\n').filter(l => /^\s*-\s+.+/.test(l));
            if (lines.length > 0) {
              inProgressSummary = `\n\n**진행중 작업 — 메모리 기준 (${lines.length}건):**\n${lines.join('\n')}`;
            }
          }
        } catch { /* no short-term memory yet */ }

        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
        const startupContent = `🔄 **시스템 재시작 완료** (${now} KST)${prStatusReport}${inProgressSummary}${pendingSummary}\n\n실제 상태 기준으로 메모리를 정리하겠습니다.`;

        // 3. Build system message with actual verified states
        let systemContent = '[시스템 재시작] 봇이 재시작되었습니다.';
        if (prStatusReport) {
          systemContent += `\n\n아래는 GitHub API로 조회한 PR 실제 상태입니다. 메모리에 기록된 PR 상태와 비교하여, 실제 상태와 다른 항목은 메모리를 업데이트하세요.${prStatusReport}`;
        }
        systemContent += '\n\n메모리 상태를 실제 상태 기준으로 점검·업데이트한 후, 채널에 상태 정리 메시지를 출력하세요.';

        const systemMsg: ConversationMessage = {
          teamId: 'system',
          teamName: 'System',
          content: systemContent,
          timestamp: new Date(),
          mentions: [startupLeader.id],
        };

        await sendAsTeam(startupChannelId, startupLeader, startupContent).catch(err =>
          console.warn('[startup] sendAsTeam failed:', err instanceof Error ? err.message : err),
        );
        addMessage(startupChannelId, systemMsg);
        handleTeamInvocation(startupLeader, systemMsg, startupChannelId, config, env, newChain());
        console.log('[startup] Leader startup message sent with verified PR statuses');
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
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.error(`[resetTeamMemory] Failed to delete ${filePath}:`, err);
      }
    }
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
  // Permission check: humanDiscordId only (#96)
  if (config.humanDiscordId && msg.author.id !== config.humanDiscordId) {
    return false;
  }

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

  if (content === '!dashboard') {
    await handleDashboardCommand(msg, config);
    saveTaskMetrics(config);
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
  continuationCount = 0,
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
    // Stress: queue pressure
    updateStress(config.workspacePath, team.id, 'queue_added', team.stressProfile);
    await waitForFree(team.id);
  }

  markBusy(team.id, triggerMsg.content.slice(0, 50));
  console.log(`[${team.name}] Invoking (chain: ${chain.totalInvocations}/${chain.maxBudget}, trigger: ${triggerMsg.content.slice(0, 80)})`);

  try {
    await executeInvocation(team, triggerMsg, channelId, config, env, chain, continuationCount);
  } finally {
    markFree(team.id);
  }
}

// ---------------------------------------------------------------------------
// Inner invocation logic — separated so timeout continuations can recurse
// directly while the team stays busy (no markFree/markBusy gap = no race).
// ---------------------------------------------------------------------------

async function executeInvocation(
  team: TeamConfig,
  triggerMsg: ConversationMessage,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
  chain: ChainContext,
  continuationCount: number,
): Promise<void> {
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

    console.log(`[${team.name}] Done (output: ${result.output ? result.output.length + ' chars' : 'empty'}, cost: $${result.cost.toFixed(4)}${result.timedOut ? ', TIMED OUT' : ''})`);

    // Handle timeout continuation — recurse directly while team stays busy
    if (result.timedOut) {
      if (continuationCount < MAX_TIMEOUT_CONTINUATIONS) {
        console.log(`[${team.name}] Timeout detected, continuing (${continuationCount + 1}/${MAX_TIMEOUT_CONTINUATIONS})`);
        await appendToInbox(
          team.id,
          'System',
          `[시간 초과] 이전 작업이 시간 초과로 중단되었습니다. Short-term Memory를 확인하고 이어서 작업해주세요.`,
          config.workspacePath,
          channelId,
        ).catch(() => {});

        // Update busy status for observability
        markBusy(team.id, `continuation ${continuationCount + 1}/${MAX_TIMEOUT_CONTINUATIONS}`);

        const continuationMsg: ConversationMessage = {
          teamId: 'system',
          teamName: 'System',
          content: `[보고 요청] 이전 작업 결과를 보고해주세요. 작업 내용: ${triggerMsg.content.slice(0, 200)}`,
          timestamp: new Date(),
          mentions: [team.id],
        };
        // Direct recursion — team stays busy, no markFree gap = no race with external triggers
        return executeInvocation(team, continuationMsg, channelId, config, env, chain, continuationCount + 1);
      }
      console.warn(`[${team.name}] Max continuations reached (${MAX_TIMEOUT_CONTINUATIONS}), not retrying`);
      await sendAsTeam(channelId, team, `작업이 시간 초과되었습니다. 다음 호출 시 메모리에서 이어서 작업합니다.`).catch(() => {});
      return;
    }

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

    // Record in conversation history (skip if output is null/empty)
    const mentionedTeams = findMentionedTeams(result.output, config);
    if (finalOutput) {
      const teamMsg: ConversationMessage = {
        teamId: team.id,
        teamName: team.name,
        content: finalOutput,
        timestamp: new Date(),
        mentions: mentionedTeams.map(t => t.id),
      };
      addMessage(channelId, teamMsg);
    }

    // Write episode (await — must complete before markFree to prevent race with compactEpisodes)
    await writeEpisode(
      team.id, team.name, channelId, triggerMsg, result.output,
      mentionedTeams.map(t => t.id), config.workspacePath,
    ).catch(err => console.error(`[episode] ${err}`));

    // Size-based consolidation trigger
    checkSizeBasedConsolidation(team.id, team.name, config);

    // Stress: detect positive feedback in trigger message
    if (detectPositiveFeedback(triggerMsg.content)) {
      updateStress(config.workspacePath, team.id, 'positive_feedback', team.stressProfile);
    }

    // Stress: Level 3 overload alert to leader
    if (shouldSendLevel3Alert(config.workspacePath, team.id)) {
      const leaderTeam = Object.values(config.teams).find(t => t.isLeader);
      if (leaderTeam) {
        try {
          await appendToInbox(
            leaderTeam.id,
            'System',
            `[과부하 알림] ${team.name} 스트레스 레벨 3 도달. 작업 재조정이 필요합니다.`,
            config.workspacePath,
            channelId,
          );
          // Only mark as sent after successful inbox write to avoid missing alerts on failure
          markLevel3AlertSent(config.workspacePath, team.id);
        } catch {
          console.warn(`[${team.name}] Failed to send Level 3 alert to inbox, will retry next cycle`);
        }
      }
    }

    // Resolve any pending dispatch records (this team reported back)
    ledger.resolve(team.id, mentionedTeams.map(t => t.id));

    // ---------------------------------------------------------------------------
    // Dispatch: Leader dispatches to all mentioned teams directly.
    // Non-leader dispatches to peer (non-leader) teams directly, while routing
    // leader mentions through the leader's inbox for centralized handling.
    // ---------------------------------------------------------------------------
    if (finalOutput) {
      if (team.isLeader) {
        // Leader dispatches directly to mentioned teams
        dispatchMentionedTeams(finalOutput, result.output, team, channelId, config, env, chain);
      } else {
        // Non-leader: dispatch to peer teams directly + notify leader via inbox
        const mentionedInOutput = findMentionedTeams(result.output, config);
        const nonSelfMentions = mentionedInOutput.filter(
          t => t.id !== team.id && t.discordUserId !== config.humanDiscordId,
        );
        if (nonSelfMentions.length > 0) {
          // Notify leader inbox for visibility
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
          // Direct dispatch: invoke all mentioned targets (including leader) immediately
          dispatchMentionedTeams(finalOutput, result.output, team, channelId, config, env, chain);
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${team.name}] Error: ${errorMsg}`);
    await sendAsTeam(channelId, team, `Error: ${errorMsg}`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
  }
}

// ---------------------------------------------------------------------------
// Centralized dispatch — invoke mentioned teams from agent output
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
