import { EmbedBuilder } from 'discord.js';
import type { TeamConfig } from '../types.js';

export function teamStatusEmbed(
  team: TeamConfig,
  status: string,
  detail?: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(team.color)
    .setAuthor({ name: team.name, iconURL: team.avatar })
    .setDescription(status)
    .setTimestamp();
  if (detail) embed.addFields({ name: 'Detail', value: detail });
  return embed;
}

export function progressEmbed(
  team: TeamConfig,
  taskSubject: string,
  teammateName?: string,
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(team.color)
    .setAuthor({ name: team.name, iconURL: team.avatar })
    .setDescription(`Subtask done: **${taskSubject}**`)
    .setFooter({ text: teammateName ? `by ${teammateName}` : 'lead' })
    .setTimestamp();
}
