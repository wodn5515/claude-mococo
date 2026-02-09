import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, closeRL } from '../readline-utils.js';

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

  if (fs.existsSync(path.join(cwd, 'teams.json'))) {
    console.error('A mococo workspace already exists in this directory.');
    process.exit(1);
  }

  console.log('Initializing mococo workspace...\n');

  const channelId = await ask('Discord work channel ID (leave empty for all channels)');
  const humanId = await ask('Your Discord user ID (right-click your name → Copy User ID)');

  // teams.json
  const teamsJson: Record<string, unknown> = {
    teams: {},
    globalDeny: ['gh pr merge', 'git push --force main', 'git push --force master'],
    conversationWindow: 30,
  };
  if (humanId) {
    teamsJson.humanDiscordId = humanId;
  }
  fs.writeFileSync(path.join(cwd, 'teams.json'), JSON.stringify(teamsJson, null, 2) + '\n');

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

  // Directories
  fs.mkdirSync(path.join(cwd, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'repos'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'repos', '.gitkeep'), '');
  fs.mkdirSync(path.join(cwd, '.mococo'), { recursive: true });

  // Copy hooks from package
  const packageRoot = getPackageRoot();
  const srcHooks = path.join(packageRoot, 'hooks');
  const destHooks = path.join(cwd, 'hooks');
  if (fs.existsSync(srcHooks)) {
    copyDir(srcHooks, destHooks);
    // Make scripts executable
    for (const f of fs.readdirSync(destHooks)) {
      if (f.endsWith('.sh')) {
        fs.chmodSync(path.join(destHooks, f), 0o755);
      }
    }
  } else {
    fs.mkdirSync(destHooks, { recursive: true });
    console.warn('Warning: hooks/ not found in package. You may need to copy them manually.');
  }

  closeRL();

  console.log('\nWorkspace created:');
  console.log('  teams.json   — assistant configuration');
  console.log('  .env         — tokens and settings');
  console.log('  prompts/     — personality files');
  console.log('  repos/       — linked repositories');
  console.log('  hooks/       — Claude Code hooks');
  console.log('\nNext: run `mococo add` to add your first assistant.');
}
