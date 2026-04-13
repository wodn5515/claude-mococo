import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from './types.js';
import type { BotConfig, GlobalConfig, RepoInfo } from './types.js';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function botDir(botId: string): string {
  return path.join(MOCOCO_HOME, 'bots', botId);
}

export function repoDir(repoName: string): string {
  return path.join(MOCOCO_HOME, 'repos', repoName);
}

// ---------------------------------------------------------------------------
// Global config
// ---------------------------------------------------------------------------

const GLOBAL_CONFIG_PATH = path.join(MOCOCO_HOME, 'global.json');

const DEFAULT_GLOBAL: GlobalConfig = {
  globalDeny: ['gh pr merge', 'git push --force main', 'git push --force master'],
  conversationWindow: 30,
  humanTitle: 'Boss',
};

export function loadGlobalConfig(): GlobalConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf-8'));
    return { ...DEFAULT_GLOBAL, ...raw };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`global.json not found. Run "mococo init" first.`);
    }
    throw err;
  }
}

export function saveGlobalConfig(config: GlobalConfig): void {
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Bot config
// ---------------------------------------------------------------------------

export function loadBotConfig(botId: string): BotConfig {
  const configPath = path.join(botDir(botId), 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    return {
      id: botId,
      ...raw,
      permissions: raw.permissions ?? {},
      allowedDirs: raw.allowedDirs ?? [],
      maxBudget: raw.maxBudget ?? 10,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Bot "${botId}" not found. Run "mococo adopt ${botId}" first.`);
    }
    throw err;
  }
}

export function saveBotConfig(botId: string, config: Omit<BotConfig, 'id'>): void {
  const dir = botDir(botId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Bot persona
// ---------------------------------------------------------------------------

export function loadPersona(botId: string): string {
  const personaPath = path.join(botDir(botId), 'persona.md');
  try {
    return fs.readFileSync(personaPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function savePersona(botId: string, content: string): void {
  const dir = botDir(botId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.md'), content);
}

// ---------------------------------------------------------------------------
// Bot personal memory
// ---------------------------------------------------------------------------

export function loadBotMemory(botId: string): string {
  const memPath = path.join(botDir(botId), 'memory.md');
  try {
    return fs.readFileSync(memPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function saveBotMemory(botId: string, content: string): void {
  const dir = botDir(botId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), content);
}

// ---------------------------------------------------------------------------
// Repo memory (shared across all bots)
// ---------------------------------------------------------------------------

export function loadRepoContext(repoName: string): string {
  const ctxPath = path.join(repoDir(repoName), 'context.md');
  try {
    return fs.readFileSync(ctxPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function saveRepoContext(repoName: string, content: string): void {
  const dir = repoDir(repoName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'context.md'), content);
}

export function loadWorklog(repoName: string): string {
  const wlPath = path.join(repoDir(repoName), 'worklog.md');
  try {
    return fs.readFileSync(wlPath, 'utf-8').trim();
  } catch {
    return '';
  }
}

export function appendWorklog(repoName: string, entry: string): void {
  const dir = repoDir(repoName);
  fs.mkdirSync(dir, { recursive: true });
  const wlPath = path.join(dir, 'worklog.md');
  fs.appendFileSync(wlPath, entry + '\n');
}

// ---------------------------------------------------------------------------
// List bots / repos
// ---------------------------------------------------------------------------

export function listBotIds(): string[] {
  const botsDir = path.join(MOCOCO_HOME, 'bots');
  try {
    return fs.readdirSync(botsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(botsDir, d.name, 'config.json')))
      .map(d => d.name);
  } catch {
    return [];
  }
}

export function listRepoNames(): string[] {
  const reposDir = path.join(MOCOCO_HOME, 'repos');
  try {
    return fs.readdirSync(reposDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Build repo summaries for triage
// ---------------------------------------------------------------------------

const WORKLOG_SUMMARY_LINES = 20;

export function loadRepoSummaries(allowedDirs: string[]): RepoInfo[] {
  const infos: RepoInfo[] = [];

  for (const dirPath of allowedDirs) {
    const name = path.basename(dirPath);
    const context = loadRepoContext(name);
    const fullWorklog = loadWorklog(name);
    // Take last N lines as summary
    const lines = fullWorklog.split('\n');
    const worklogSummary = lines.slice(-WORKLOG_SUMMARY_LINES).join('\n');

    infos.push({ name, path: dirPath, context, worklogSummary });
  }

  return infos;
}
