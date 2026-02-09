import type { TeamsConfig, TeamConfig } from '../types.js';
import { getLeaderTeam } from '../config.js';

export function findMentionedTeams(
  content: string,
  config: TeamsConfig,
): TeamConfig[] {
  const mentioned: TeamConfig[] = [];
  for (const team of Object.values(config.teams)) {
    // Match @TeamName or @teamId
    const pattern = new RegExp(`@${team.name}\\b`, 'i');
    if (pattern.test(content)) {
      mentioned.push(team);
      continue;
    }
    const idPattern = new RegExp(`@${team.id}\\b`, 'i');
    if (idPattern.test(content)) {
      mentioned.push(team);
      continue;
    }
    // Match Discord mention format <@discordUserId>
    if (team.discordUserId && content.includes(`<@${team.discordUserId}>`)) {
      mentioned.push(team);
    }
  }
  return mentioned;
}

export function routeMessage(
  content: string,
  isHuman: boolean,
  config: TeamsConfig,
): TeamConfig[] {
  const targets: TeamConfig[] = [];

  const mentioned = findMentionedTeams(content, config);
  targets.push(...mentioned);

  // If human message with no specific mention → route to Leader
  if (isHuman && mentioned.length === 0) {
    const leader = getLeaderTeam(config);
    if (leader) targets.push(leader);
  }

  return targets;
}
