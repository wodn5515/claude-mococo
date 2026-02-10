import 'dotenv/config';
import { loadTeamsConfig } from './config.js';
import { createBots } from './bot/client.js';
import { startHookServer } from './server/hook-receiver.js';
import type { EnvConfig } from './types.js';

async function main() {
  const config = loadTeamsConfig();
  const env: EnvConfig = {
    workChannelId: process.env.WORK_CHANNEL_ID || undefined,
    hookPort: parseInt(process.env.HOOK_PORT ?? '9876'),
    memberTrackingChannelId: process.env.MEMBER_TRACKING_CHANNEL_ID || undefined,
  };

  if (!env.workChannelId) {
    console.log('WORK_CHANNEL_ID not set — bot will respond in all channels.');
  }

  // Check how many teams have Discord tokens configured
  const teamsWithTokens = Object.values(config.teams).filter(t => t.discordToken);
  if (teamsWithTokens.length === 0) {
    console.error('No team has a Discord token configured.');
    console.error('Set <TEAM_ID>_DISCORD_TOKEN in .env for each team (e.g., LEADER_DISCORD_TOKEN=xxx).');
    process.exit(1);
  }

  startHookServer(env.hookPort);

  console.log(`Starting ${teamsWithTokens.length} team bots...`);
  await createBots(config, env);

  const teamCount = Object.keys(config.teams).length;
  const engines = [...new Set(Object.values(config.teams).map(t => t.engine))];
  console.log(`claude-mococo running — ${teamsWithTokens.length}/${teamCount} teams online (engines: ${engines.join(', ')})`);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
