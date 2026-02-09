import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, type TextChannel, type Message } from 'discord.js';
import { routeMessage, findMentionedTeams } from './router.js';
import { invokeTeam } from '../teams/invoker.js';
import { addMessage, getRecentConversation } from '../teams/context.js';
import { isBusy, markBusy, markFree, waitForFree, getStatus } from '../teams/concurrency.js';
import { hookEvents } from '../server/hook-receiver.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage } from '../types.js';

// Map teamId → their Discord client (so teams can send messages as themselves)
const teamClients = new Map<string, Client>();

/** Send a message as a specific team using that team's own Discord bot */
async function sendAsTeam(channelId: string, team: TeamConfig, content: string) {
  const client = teamClients.get(team.id);
  if (!client) return;

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  // Discord messages max 2000 chars; split if needed
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

/** Create and login all team bots. Returns the leader client for admin commands. */
export async function createBots(config: TeamsConfig, env: EnvConfig): Promise<void> {
  // Collect all bot user IDs so we can ignore messages from our own bots
  const botUserIds = new Set<string>();

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

  // Create one Discord client per team that has a token
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
      ],
    });

    client.on('ready', () => {
      if (client.user) {
        botUserIds.add(client.user.id);
        // Auto-save Discord user ID to teams.json if not already set
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
      }
    });

    // Message handler for this team's bot
    client.on('messageCreate', async (msg: Message) => {
      // Per-team channel filter: if channels are specified, only respond in those
      if (team.channels && team.channels.length > 0 && !team.channels.includes(msg.channelId)) return;

      // Ignore messages from ANY of our team bots
      if (botUserIds.has(msg.author.id)) return;

      // Ignore other bots (non-mococo bots)
      if (msg.author.bot) return;

      const content = msg.content.trim();
      if (!content) return;

      // Only the Leader bot handles admin commands + unmentioned messages
      if (team.isLeader) {
        if (await handleAdminCommand(content, msg, config)) return;

        // Record human message
        const humanMsg: ConversationMessage = {
          teamId: 'human',
          teamName: msg.author.displayName,
          discordId: msg.author.id,
          content,
          timestamp: new Date(),
          mentions: findMentionedTeams(content, config).map(t => t.id),
        };
        addMessage(msg.channelId, humanMsg);

        // Route: if message mentions specific teams, invoke them; otherwise invoke Leader
        const targetTeams = routeMessage(content, true, config);
        for (const target of targetTeams) {
          handleTeamInvocation(target, humanMsg, msg.channelId, config, env);
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
        addMessage(msg.channelId, humanMsg);
        handleTeamInvocation(team, humanMsg, msg.channelId, config, env);
      }
    });

    teamClients.set(team.id, client);
    await client.login(team.discordToken);
  }
}

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

async function handleTeamInvocation(
  team: TeamConfig,
  triggerMsg: ConversationMessage,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
) {
  if (isBusy(team.id)) {
    await waitForFree(team.id);
  }

  markBusy(team.id, triggerMsg.content.slice(0, 50));

  try {
    const conversation = getRecentConversation(channelId, config.conversationWindow);

    // Show typing indicator instead of a message
    const typingClient = teamClients.get(team.id);
    const typingChannel = typingClient?.channels.cache.get(channelId) as TextChannel | undefined;
    await typingChannel?.sendTyping().catch(() => {});

    const result = await invokeTeam(team, {
      teamId: team.id,
      trigger: triggerMsg.teamId === 'human' ? 'human_message' : 'team_mention',
      message: triggerMsg,
      conversation,
    }, config);

    if (result.output) {
      await sendAsTeam(channelId, team, result.output);
    }

    const teamMsg: ConversationMessage = {
      teamId: team.id,
      teamName: team.name,
      content: result.output,
      timestamp: new Date(),
      mentions: findMentionedTeams(result.output, config).map(t => t.id),
    };
    addMessage(channelId, teamMsg);

    // If this team's output mentions other teams, invoke them
    const nextTeams = findMentionedTeams(result.output, config);
    for (const nextTeam of nextTeams) {
      if (nextTeam.id !== team.id) {
        handleTeamInvocation(nextTeam, teamMsg, channelId, config, env);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sendAsTeam(channelId, team, `Error: ${errorMsg}`).catch(() => {});
  } finally {
    markFree(team.id);
  }
}
