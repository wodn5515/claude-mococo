import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from '../../types.js';
import type { GlobalConfig } from '../../types.js';
import { ask, closeRL } from '../readline-utils.js';

export async function runInit(): Promise<void> {
  const isReinit = fs.existsSync(path.join(MOCOCO_HOME, 'global.json'));

  if (isReinit) {
    console.log('Existing adoption center detected. Updating settings...\n');
  } else {
    console.log('Creating mococo adoption center at ~/.mococo/\n');
  }

  const humanId = await ask('Your Discord user ID (right-click your name → Copy User ID)');
  const humanTitle = await ask('How should bots address you? (default: Boss)') || 'Boss';

  if (isReinit) {
    // Update existing global.json
    const existing = JSON.parse(fs.readFileSync(path.join(MOCOCO_HOME, 'global.json'), 'utf-8'));
    if (humanId) existing.humanDiscordId = humanId;
    if (humanTitle) existing.humanTitle = humanTitle;
    fs.writeFileSync(path.join(MOCOCO_HOME, 'global.json'), JSON.stringify(existing, null, 2) + '\n');
  } else {
    // Create directory structure
    fs.mkdirSync(path.join(MOCOCO_HOME, 'bots'), { recursive: true });
    fs.mkdirSync(path.join(MOCOCO_HOME, 'repos'), { recursive: true });
    fs.mkdirSync(path.join(MOCOCO_HOME, 'shared', 'inbox'), { recursive: true });

    // Create global.json
    const globalConfig: GlobalConfig = {
      humanDiscordId: humanId || undefined,
      humanTitle,
      globalDeny: ['gh pr merge', 'git push --force main', 'git push --force master'],
      conversationWindow: 30,
    };
    fs.writeFileSync(
      path.join(MOCOCO_HOME, 'global.json'),
      JSON.stringify(globalConfig, null, 2) + '\n',
    );

    // Create shared members file
    fs.writeFileSync(path.join(MOCOCO_HOME, 'shared', 'members.md'), '');
  }

  closeRL();

  if (isReinit) {
    console.log('\nAdoption center updated.');
  } else {
    console.log('\nAdoption center created:');
    console.log('  ~/.mococo/global.json   — global settings');
    console.log('  ~/.mococo/bots/         — bot configs & memory');
    console.log('  ~/.mococo/repos/        — shared repo memory');
    console.log('  ~/.mococo/shared/       — shared data');
    console.log('\nNext: run "mococo adopt <id>" to adopt your first bot.');
  }
}
