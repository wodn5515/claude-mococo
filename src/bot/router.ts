import type { TeamsConfig, TeamConfig } from '../types.js';
import { getLeaderTeam } from '../config.js';

export function findMentionedTeams(
  content: string,
  config: TeamsConfig,
): TeamConfig[] {
  const mentioned: TeamConfig[] = [];
  for (const team of Object.values(config.teams)) {
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
