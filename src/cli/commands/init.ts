import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, confirm, closeRL } from '../readline-utils.js';

function getPackageRoot(): string {
  // Resolve from dist/cli/commands/init.js → package root
  const thisFile = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(thisFile), '..', '..', '..');
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export async function runInit(): Promise<void> {
  const cwd = process.cwd();
  const teamsJsonPath = path.join(cwd, 'teams.json');
  const isReinit = fs.existsSync(teamsJsonPath);

  if (isReinit) {
    console.log('Existing mococo workspace detected. Updating settings...\n');
  } else {
    console.log('Initializing mococo workspace...\n');
  }

  const channelId = await ask('Discord work channel ID (leave empty for all channels)');
  const humanId = await ask('Your Discord user ID (right-click your name → Copy User ID)');

  if (isReinit) {
    // Update existing teams.json — preserve teams, update global settings
    const existing = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));
    if (humanId) existing.humanDiscordId = humanId;
    fs.writeFileSync(teamsJsonPath, JSON.stringify(existing, null, 2) + '\n');

    // Update .env — replace WORK_CHANNEL_ID and HOOK_PORT lines, keep token lines
    const envPath = path.join(cwd, '.env');
    let envLines: string[] = [];
    if (fs.existsSync(envPath)) {
      envLines = fs.readFileSync(envPath, 'utf-8').split('\n')
        .filter(l => !l.startsWith('WORK_CHANNEL_ID=') && !l.startsWith('HOOK_PORT='));
    }
    envLines.unshift(`WORK_CHANNEL_ID=${channelId}`, 'HOOK_PORT=9876');
    fs.writeFileSync(envPath, envLines.join('\n') + '\n');
  } else {
    // Fresh init
    const teamsJson: Record<string, unknown> = {
      teams: {},
      globalDeny: ['gh pr merge', 'git push --force main', 'git push --force master'],
      conversationWindow: 30,
    };
    if (humanId) {
      teamsJson.humanDiscordId = humanId;
    }
    fs.writeFileSync(teamsJsonPath, JSON.stringify(teamsJson, null, 2) + '\n');

    // .env
    const envContent = [
      `WORK_CHANNEL_ID=${channelId}`,
      'HOOK_PORT=9876',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cwd, '.env'), envContent);

    // .gitignore
    const gitignore = [
      '.env',
      '.mococo/',
      'repos/*',
      '!repos/.gitkeep',
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(cwd, '.gitignore'), gitignore);
  }

  // Ensure directories exist (both fresh and reinit)
  fs.mkdirSync(path.join(cwd, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'repos'), { recursive: true });
  if (!fs.existsSync(path.join(cwd, 'repos', '.gitkeep'))) {
    fs.writeFileSync(path.join(cwd, 'repos', '.gitkeep'), '');
  }
  fs.mkdirSync(path.join(cwd, '.mococo'), { recursive: true });

  // Copy/update hooks from package
  const packageRoot = getPackageRoot();
  const srcHooks = path.join(packageRoot, 'hooks');
  const destHooks = path.join(cwd, 'hooks');
  if (fs.existsSync(srcHooks)) {
    copyDir(srcHooks, destHooks);
    for (const f of fs.readdirSync(destHooks)) {
      if (f.endsWith('.sh')) {
        fs.chmodSync(path.join(destHooks, f), 0o755);
      }
    }
  } else if (!fs.existsSync(destHooks)) {
    fs.mkdirSync(destHooks, { recursive: true });
    console.warn('Warning: hooks/ not found in package. You may need to copy them manually.');
  }

  closeRL();

  if (isReinit) {
    console.log('\nWorkspace updated.');
    console.log('  teams.json   — settings updated (assistants preserved)');
    console.log('  .env         — channel/port updated (tokens preserved)');
    console.log('  hooks/       — refreshed from package');
  } else {
    console.log('\nWorkspace created:');
    console.log('  teams.json   — assistant configuration');
    console.log('  .env         — tokens and settings');
    console.log('  prompts/     — personality files');
    console.log('  repos/       — linked repositories');
    console.log('  hooks/       — Claude Code hooks');
    console.log('\nNext: run `mococo add` to add your first assistant.');
  }
}
