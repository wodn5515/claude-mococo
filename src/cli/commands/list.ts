import fs from 'node:fs';
import path from 'node:path';
import { requireWorkspace } from '../workspace.js';

export async function runList(): Promise<void> {
  const ws = requireWorkspace();
  const raw = JSON.parse(fs.readFileSync(path.join(ws, 'teams.json'), 'utf-8'));
  const teams = raw.teams as Record<string, any>;

  const ids = Object.keys(teams);
  if (ids.length === 0) {
    console.log('No assistants configured. Run `mococo add` to add one.');
    return;
  }

  console.log(`\n  ${'ID'.padEnd(16)} ${'Name'.padEnd(16)} ${'Engine'.padEnd(10)} ${'Model'.padEnd(18)} Leader`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(16)} ${'─'.repeat(10)} ${'─'.repeat(18)} ──────`);

  for (const [id, cfg] of Object.entries(teams) as [string, any][]) {
    const leader = cfg.isLeader ? 'yes' : '';
    console.log(`  ${id.padEnd(16)} ${(cfg.name ?? id).padEnd(16)} ${(cfg.engine ?? 'claude').padEnd(10)} ${(cfg.model ?? 'sonnet').padEnd(18)} ${leader}`);
  }
  console.log();
}
