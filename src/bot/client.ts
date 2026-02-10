import fs from 'node:fs';
import path from 'node:path';
import { Client, GatewayIntentBits, type TextChannel, type Message } from 'discord.js';
import { routeMessage, findMentionedTeams } from './router.js';
import { invokeTeam } from '../teams/invoker.js';
import { addMessage, getRecentConversation } from '../teams/context.js';
import { isBusy, markBusy, markFree, waitForFree, getStatus } from '../teams/concurrency.js';
import { hookEvents } from '../server/hook-receiver.js';
import { processDiscordCommands, stripMemoryBlocks, ResourceRegistry } from './discord-commands.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage } from '../types.js';

// Map teamId → their Discord client (so teams can send messages as themselves)
export const teamClients = new Map<string, Client>();

// ---------------------------------------------------------------------------
// Inbox helpers — append chat to a team's inbox file for memory processing
// ---------------------------------------------------------------------------

function appendToInbox(teamId: string, from: string, content: string, workspacePath: string) {
  const dir = path.resolve(workspacePath, '.mococo/inbox');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.resolve(dir, `${teamId}.md`);
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  fs.appendFileSync(file, `[${ts}] ${from}: ${content}\n`);
}

function clearInbox(teamId: string, workspacePath: string) {
  const file = path.resolve(workspacePath, '.mococo/inbox', `${teamId}.md`);
  try { fs.unlinkSync(file); } catch {}
}

// Shared resource registry for discord command name→id resolution
const registry = new ResourceRegistry();

/** Send a message as a specific team using that team's own Discord bot */
export async function sendAsTeam(channelId: string, team: TeamConfig, content: string) {
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

    client.on('clientReady', () => {
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

        // Check if message @mentions a specific non-leader bot via Discord
        const mentionsOtherBot = Object.values(config.teams).some(t =>
          !t.isLeader && t.discordUserId && msg.mentions.users.has(t.discordUserId)
        );

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

        // Leader reads every message — append to inbox for memory processing
        appendToInbox(team.id, msg.author.displayName, content, config.workspacePath);

        // If user @mentioned a specific bot, let that bot's own handler deal with it
        if (mentionsOtherBot) return;

        // Route: if message mentions specific teams by name, invoke them; otherwise invoke Leader
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
        appendToInbox(team.id, msg.author.displayName, content, config.workspacePath);
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
  console.log(`[${team.name}] Invoking (trigger: ${triggerMsg.content.slice(0, 80)})`);

  // Show typing indicator until the engine finishes
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
    }, config);

    console.log(`[${team.name}] Done (output: ${result.output ? result.output.length + ' chars' : 'empty'}, cost: $${result.cost.toFixed(4)})`);

    // Strip memory/persona blocks before anything else (no guild needed)
    let finalOutput = result.output;
    if (finalOutput) {
      finalOutput = stripMemoryBlocks(finalOutput, team.id, config.workspacePath);
    }

    // Process discord commands (channels, threads, categories, messages) and clean output
    if (finalOutput) {
      // Resolve guild from the channel
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

    if (finalOutput) {
      await sendAsTeam(channelId, team, finalOutput);
    }

    const teamMsg: ConversationMessage = {
      teamId: team.id,
      teamName: team.name,
      content: finalOutput,
      timestamp: new Date(),
      mentions: findMentionedTeams(result.output, config).map(t => t.id),
    };
    addMessage(channelId, teamMsg);

    // Append this bot's response to all other teams' inboxes
    if (finalOutput) {
      for (const otherTeam of Object.values(config.teams)) {
        if (otherTeam.id !== team.id) {
          appendToInbox(otherTeam.id, team.name, finalOutput, config.workspacePath);
        }
      }
    }

    // If this team's output mentions other teams, invoke them
    const nextTeams = findMentionedTeams(finalOutput, config);
    for (const nextTeam of nextTeams) {
      if (nextTeam.id !== team.id) {
        handleTeamInvocation(nextTeam, teamMsg, channelId, config, env);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[${team.name}] Error: ${errorMsg}`);
    await sendAsTeam(channelId, team, `Error: ${errorMsg}`).catch(() => {});
  } finally {
    clearInterval(typingInterval);
    clearInbox(team.id, config.workspacePath);
    markFree(team.id);
  }
}
