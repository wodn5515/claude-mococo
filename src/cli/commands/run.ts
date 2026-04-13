import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from '../../types.js';
import { loadGlobalConfig, loadBotConfig, loadPersona, loadBotMemory } from '../../config.js';
import { createBotRunner } from '../../bot/runner.js';

export async function runBot(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: mococo run <id>');
    process.exit(1);
  }

  if (!fs.existsSync(path.join(MOCOCO_HOME, 'global.json'))) {
    console.error('No adoption center found. Run "mococo init" first.');
    process.exit(1);
  }

  const globalConfig = loadGlobalConfig();
  const botConfig = loadBotConfig(id);

  // Resolve Discord token from env
  const discordToken = process.env[botConfig.discordTokenEnv];
  if (!discordToken) {
    console.error(`Missing env var ${botConfig.discordTokenEnv}. Set it before running.`);
    process.exit(1);
  }

  console.log(`Starting ${botConfig.name} (${id}) — ${botConfig.engine}/${botConfig.model}`);
  if (botConfig.isLeader) console.log('  Role: leader (responds to all messages)');
  if (botConfig.allowedDirs.length > 0) {
    console.log(`  Directories: ${botConfig.allowedDirs.join(', ')}`);
  }

  await createBotRunner(botConfig, globalConfig, discordToken);
}
