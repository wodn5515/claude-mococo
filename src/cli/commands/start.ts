import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { loadTeamsConfig } from '../../config.js';
import { createBots } from '../../bot/client.js';
import { startHookServer } from '../../server/hook-receiver.js';
import { requireWorkspace } from '../workspace.js';
import type { EnvConfig } from '../../types.js';

export async function runStart(): Promise<void> {
  const ws = requireWorkspace();

  // Load .env from workspace
  loadDotenv({ path: path.join(ws, '.env') });

  const config = loadTeamsConfig(ws);

  const env: EnvConfig = {
    workChannelId: process.env.WORK_CHANNEL_ID || undefined,
    hookPort: parseInt(process.env.HOOK_PORT ?? '9876'),
  };

  if (!env.workChannelId) {
    console.log('WORK_CHANNEL_ID not set — bot will respond in all channels.');
  }

  const teamsWithTokens = Object.values(config.teams).filter(t => t.discordToken);
  if (teamsWithTokens.length === 0) {
    console.error('No assistant has a Discord token configured.');
    console.error('Run `mococo add` to add an assistant, or set tokens in .env');
    process.exit(1);
  }

  startHookServer(env.hookPort);

  console.log(`Starting ${teamsWithTokens.length} assistant(s)...`);
  await createBots(config, env);

  const teamCount = Object.keys(config.teams).length;
  const engines = [...new Set(Object.values(config.teams).map(t => t.engine))];
  console.log(`mococo running — ${teamsWithTokens.length}/${teamCount} assistants online (engines: ${engines.join(', ')})`);
}
