import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from '../../types.js';
import type { BotConfig } from '../../types.js';
import { saveBotConfig, savePersona, botDir } from '../../config.js';
import { ask, closeRL } from '../readline-utils.js';

export async function runAdopt(id?: string): Promise<void> {
  if (!fs.existsSync(path.join(MOCOCO_HOME, 'global.json'))) {
    console.error('No adoption center found. Run "mococo init" first.');
    process.exit(1);
  }

  if (!id) {
    id = await ask('Bot ID (lowercase, no spaces, e.g. "stack")');
    if (!id) {
      console.error('Bot ID is required.');
      closeRL();
      process.exit(1);
    }
  }

  // Check if already exists
  if (fs.existsSync(path.join(botDir(id), 'config.json'))) {
    console.error(`Bot "${id}" already exists. Use "mococo edit ${id}" to modify.`);
    closeRL();
    process.exit(1);
  }

  console.log(`\nAdopting new mococo: ${id}\n`);

  const name = await ask('Display name (e.g. "스택코코")') || id;
  const engine = (await ask('Engine (claude/codex/gemini, default: claude)') || 'claude') as BotConfig['engine'];
  const model = await ask('Model (e.g. sonnet, opus, default: sonnet)') || 'sonnet';
  const discordToken = await ask('Discord bot token');
  const isLeaderStr = await ask('Is this the leader bot? (y/N)');
  const isLeader = isLeaderStr?.toLowerCase() === 'y';

  // Allowed directories
  console.log('\nAllowed directories (absolute paths this bot can work in):');
  console.log('Enter one per line. Empty line to finish.\n');
  const allowedDirs: string[] = [];
  while (true) {
    const dir = await ask(`  Directory ${allowedDirs.length + 1}`);
    if (!dir) break;
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      console.warn(`  Warning: ${resolved} does not exist (will be created when needed)`);
    }
    allowedDirs.push(resolved);

    // Ensure repo memory dir exists for this directory
    const repoName = path.basename(resolved);
    const repoMemDir = path.join(MOCOCO_HOME, 'repos', repoName);
    fs.mkdirSync(repoMemDir, { recursive: true });
    if (!fs.existsSync(path.join(repoMemDir, 'context.md'))) {
      fs.writeFileSync(path.join(repoMemDir, 'context.md'), '');
    }
    if (!fs.existsSync(path.join(repoMemDir, 'worklog.md'))) {
      fs.writeFileSync(path.join(repoMemDir, 'worklog.md'), '');
    }
  }

  // Git identity
  const gitName = await ask('Git author name (default: bot display name)') || name;
  const gitEmail = await ask('Git author email') || `${id}@users.noreply.github.com`;

  // Save Discord token to ~/.mococo/.env
  const discordTokenEnv = `${id.toUpperCase()}_DISCORD_TOKEN`;
  if (discordToken) {
    const envPath = path.join(MOCOCO_HOME, '.env');
    let envContent = '';
    try {
      envContent = fs.readFileSync(envPath, 'utf-8');
    } catch {
      envContent = '# Discord bot tokens (auto-loaded by mococo)\n\n';
    }

    // Remove existing line for this bot if present
    const lines = envContent.split('\n').filter(l => !l.startsWith(`${discordTokenEnv}=`));
    lines.push(`${discordTokenEnv}=${discordToken}`);

    fs.writeFileSync(envPath, lines.join('\n') + '\n');
    console.log(`\nDiscord token saved to ~/.mococo/.env (auto-loaded on every run)`);
  } else {
    console.log(`\nNo token provided. Add it later to ~/.mococo/.env:`);
    console.log(`  ${discordTokenEnv}=<your-token>`);
  }

  // Build config (without id — it's inferred from the directory name)
  const config: Omit<BotConfig, 'id'> = {
    name,
    engine,
    model,
    maxBudget: 10,
    discordTokenEnv,
    isLeader,
    allowedDirs,
    permissions: {
      deny: isLeader ? ['git push', 'gh pr', 'Edit', 'Write'] : [],
    },
    git: { name: gitName, email: gitEmail },
  };

  saveBotConfig(id, config);

  // Create default persona
  const persona = `# ${name}

You are **${name}**, an AI assistant on Discord.

## Role
${isLeader ? 'You are the team leader. You coordinate tasks, delegate to other bots, and report status.' : 'You are a team member. You receive tasks from the leader and execute them.'}

## Rules
- Always respond in the same language as the message you received
- Be concise and direct
- Update your memory after each task
`;

  savePersona(id, persona);

  // Create empty memory
  fs.writeFileSync(path.join(botDir(id), 'memory.md'), '');

  closeRL();

  console.log(`\nBot "${name}" (${id}) adopted successfully!`);
  console.log(`\nConfig: ~/.mococo/bots/${id}/config.json`);
  console.log(`Persona: ~/.mococo/bots/${id}/persona.md`);
  console.log(`\nTo run: mococo run ${id}`);
}
