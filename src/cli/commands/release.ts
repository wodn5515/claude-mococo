import fs from 'node:fs';
import { botDir } from '../../config.js';
import { ask, closeRL } from '../readline-utils.js';

export async function runRelease(id?: string): Promise<void> {
  if (!id) {
    console.error('Usage: mococo release <id>');
    process.exit(1);
  }

  const dir = botDir(id);
  if (!fs.existsSync(dir)) {
    console.error(`Bot "${id}" not found.`);
    process.exit(1);
  }

  const confirm = await ask(`Release bot "${id}"? This deletes all bot data. (y/N)`);
  closeRL();

  if (confirm?.toLowerCase() !== 'y') {
    console.log('Cancelled.');
    return;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`Bot "${id}" released. Shared repo data is preserved.`);
}
