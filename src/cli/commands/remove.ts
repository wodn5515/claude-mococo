import fs from 'node:fs';
import path from 'node:path';
import { requireWorkspace } from '../workspace.js';

export async function runRemove(name: string): Promise<void> {
  if (!name) {
    console.error('Usage: mococo remove <assistant-id>');
    process.exit(1);
  }

  const ws = requireWorkspace();
  const teamsJsonPath = path.join(ws, 'teams.json');
  const raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));

  if (!raw.teams[name]) {
    console.error(`Assistant "${name}" not found.`);
    const ids = Object.keys(raw.teams);
    if (ids.length > 0) {
      console.error(`Available: ${ids.join(', ')}`);
    }
    process.exit(1);
  }

  // Remove from teams.json
  delete raw.teams[name];
  fs.writeFileSync(teamsJsonPath, JSON.stringify(raw, null, 2) + '\n');

  // Remove prompt file
  const promptPath = path.join(ws, 'prompts', `${name}.md`);
  if (fs.existsSync(promptPath)) {
    fs.unlinkSync(promptPath);
  }

  // Remove token lines from .env
  const envPath = path.join(ws, '.env');
  if (fs.existsSync(envPath)) {
    const prefix = `${name.toUpperCase()}_`;
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    const filtered = lines.filter(line => !line.startsWith(prefix));
    fs.writeFileSync(envPath, filtered.join('\n'));
  }

  console.log(`Removed assistant "${name}".`);
}
