import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder } from 'discord.js';
import { formatTimeAgo } from './episode-writer.js';
import { ledger } from '../teams/dispatch-ledger.js';
import type { TeamsConfig, Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_COUNT = 10;
const MAX_COUNT = 50;

// ---------------------------------------------------------------------------
// loadEpisodes — read raw Episode objects from a team's episodes.jsonl
// ---------------------------------------------------------------------------

function loadEpisodes(
  teamId: string,
  workspacePath: string,
  count: number,
): Episode[] {
  const filePath = path.resolve(workspacePath, '.mococo/memory', teamId, 'episodes.jsonl');

  let lines: string[];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  } catch {
    return [];
  }

  const recent = lines.slice(-count);
  const episodes: Episode[] = [];
  for (const line of recent) {
    try {
      const ep: Episode = JSON.parse(line);
      if (typeof ep.ts === 'number' && !isNaN(ep.ts)) {
        episodes.push(ep);
      }
    } catch {
      // skip corrupted lines
    }
  }
  return episodes;
}

// ---------------------------------------------------------------------------
// formatEpisodeLine — single episode to display string
// ---------------------------------------------------------------------------

function formatEpisodeLine(ep: Episode): string {
  const ago = formatTimeAgo(Date.now() - ep.ts);
  const summary = ep.summary || '(no summary)';
  const triggerIcon = ep.trigger === 'human_message' ? '\u{1F464}'
    : ep.trigger === 'system' ? '\u{2699}\u{FE0F}'
    : '\u{1F4E8}';
  return `\`${ago}\` ${triggerIcon} ${summary}`;
}

// ---------------------------------------------------------------------------
// buildHistoryEmbeds — main entry point called from client.ts
// ---------------------------------------------------------------------------

export function buildHistoryEmbeds(
  config: TeamsConfig,
  agentArg?: string,
  countArg?: number,
): EmbedBuilder[] {
  const count = Math.min(Math.max(countArg || DEFAULT_COUNT, 1), MAX_COUNT);
  const teams = config.teams;

  // Determine which agent(s) to show
  if (agentArg === 'all') {
    return buildAllTeamsEmbed(config, count);
  }

  // Find the target team
  let targetId: string | undefined;
  if (agentArg) {
    // Match by id or name (case-insensitive)
    targetId = Object.keys(teams).find(
      id => id === agentArg || teams[id].name.toLowerCase() === agentArg.toLowerCase(),
    );
    if (!targetId) {
      const available = Object.values(teams).map(t => `\`${t.id}\``).join(', ');
      return [
        new EmbedBuilder()
          .setColor(0xFF0000)
          .setTitle('Agent not found')
          .setDescription(`Unknown agent: \`${agentArg}\`\nAvailable: ${available}\nUse \`!history all\` for combined view.`),
      ];
    }
  } else {
    // Default to leader
    targetId = Object.keys(teams).find(id => teams[id].isLeader);
    if (!targetId) {
      targetId = Object.keys(teams)[0];
    }
  }

  if (!targetId) {
    return [
      new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('No teams configured')
        .setDescription('No teams found in configuration.'),
    ];
  }

  return [buildSingleTeamEmbed(config, targetId, count)];
}

// ---------------------------------------------------------------------------
// buildSingleTeamEmbed — embed for one specific agent
// ---------------------------------------------------------------------------

function buildSingleTeamEmbed(
  config: TeamsConfig,
  teamId: string,
  count: number,
): EmbedBuilder {
  const team = config.teams[teamId];
  const episodes = loadEpisodes(teamId, config.workspacePath, count);
  const unresolved = ledger.getUnresolved().filter(r => r.toTeam === teamId);

  const embed = new EmbedBuilder()
    .setColor(team.color)
    .setAuthor({ name: team.name, iconURL: team.avatar })
    .setTitle(`Work History (last ${count})`)
    .setTimestamp();

  // Episodes section
  if (episodes.length > 0) {
    const lines = episodes.map(formatEpisodeLine);
    // Discord embed field value limit is 1024 chars
    let value = lines.join('\n');
    if (value.length > 1024) {
      value = value.slice(0, 1020) + '\n...';
    }
    embed.addFields({ name: 'Recent Activity', value });
  } else {
    embed.addFields({ name: 'Recent Activity', value: 'No activity recorded.' });
  }

  // Unresolved dispatches section
  if (unresolved.length > 0) {
    const dispatchLines = unresolved.map(r => {
      const ago = formatTimeAgo(Date.now() - r.dispatchedAt);
      return `\`${ago}\` ${r.fromTeam} \u2192 ${r.reason.slice(0, 80)}`;
    });
    let value = dispatchLines.join('\n');
    if (value.length > 1024) {
      value = value.slice(0, 1020) + '\n...';
    }
    embed.addFields({ name: 'Pending Dispatches', value });
  }

  embed.setFooter({ text: `Engine: ${team.engine}/${team.model}` });
  return embed;
}

// ---------------------------------------------------------------------------
// buildAllTeamsEmbed — combined view across all teams
// ---------------------------------------------------------------------------

function buildAllTeamsEmbed(
  config: TeamsConfig,
  count: number,
): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  for (const [teamId, team] of Object.entries(config.teams)) {
    const episodes = loadEpisodes(teamId, config.workspacePath, count);
    if (episodes.length === 0) continue;

    const lines = episodes.map(formatEpisodeLine);
    let value = lines.join('\n');
    if (value.length > 1024) {
      value = value.slice(0, 1020) + '\n...';
    }

    const embed = new EmbedBuilder()
      .setColor(team.color)
      .setAuthor({ name: team.name, iconURL: team.avatar })
      .addFields({ name: `Recent Activity (last ${count})`, value });

    embeds.push(embed);
  }

  // Discord allows max 10 embeds per message
  if (embeds.length === 0) {
    return [
      new EmbedBuilder()
        .setColor(0x808080)
        .setTitle('Team History')
        .setDescription('No activity recorded for any team.'),
    ];
  }

  return embeds.slice(0, 10);
}
