import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, confirm, closeRL } from '../readline-utils.js';
import { t, isLangExplicit, setLang } from '../i18n.js';

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
  // Language selection if --lang not specified
  if (!isLangExplicit()) {
    const useKo = await confirm(t('lang.prompt'), false);
    if (useKo) setLang('ko', true);
  }

  const cwd = process.cwd();
  const teamsJsonPath = path.join(cwd, 'teams.json');
  const isReinit = fs.existsSync(teamsJsonPath);

  if (isReinit) {
    console.log(t('init.existing'));
  } else {
    console.log(t('init.fresh'));
  }

  const channelId = await ask(t('init.askChannel'));
  const humanId = await ask(t('init.askHumanId'));

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

  // Copy default shared-rules.md if not present
  const sharedRulesPath = path.join(cwd, 'prompts', 'shared-rules.md');
  if (!fs.existsSync(sharedRulesPath)) {
    const defaultRules = path.join(getPackageRoot(), 'defaults', 'shared-rules.md');
    if (fs.existsSync(defaultRules)) {
      fs.copyFileSync(defaultRules, sharedRulesPath);
    }
  }

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
    console.warn(t('init.hooksWarn'));
  }

  closeRL();

  if (isReinit) {
    console.log(t('init.updated'));
    console.log(t('init.updatedTeams'));
    console.log(t('init.updatedEnv'));
    console.log(t('init.updatedHooks'));
  } else {
    console.log(t('init.created'));
    console.log(t('init.createdTeams'));
    console.log(t('init.createdEnv'));
    console.log(t('init.createdPrompts'));
    console.log(t('init.createdRepos'));
    console.log(t('init.createdHooks'));
    console.log(t('init.next'));
  }
}
