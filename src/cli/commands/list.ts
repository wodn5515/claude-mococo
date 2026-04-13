import { listBotIds, loadBotConfig } from '../../config.js';

export async function runList(): Promise<void> {
  const botIds = listBotIds();

  if (botIds.length === 0) {
    console.log('No bots adopted yet. Run "mococo adopt <id>" to get started.');
    return;
  }

  console.log('Adopted bots:\n');
  for (const id of botIds) {
    try {
      const config = loadBotConfig(id);
      const leader = config.isLeader ? ' (leader)' : '';
      const dirs = config.allowedDirs.length > 0
        ? config.allowedDirs.map(d => `    → ${d}`).join('\n')
        : '    (no directories configured)';
      console.log(`  ${config.name} [${id}] — ${config.engine}/${config.model}${leader}`);
      console.log(dirs);
      console.log();
    } catch (err) {
      console.log(`  ${id} — (config error: ${(err as Error).message})`);
    }
  }
}
