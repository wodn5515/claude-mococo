import { spawn } from 'node:child_process';
import type { BotConfig, ExecutionResult } from '../types.js';

const MAX_STDOUT_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_STDERR_BYTES = 8192;
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Whitelist of env vars safe to pass to child processes */
const ENV_WHITELIST = [
  'PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM', 'NODE_ENV',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_PAT',
  'TMPDIR', 'TMP', 'TEMP',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
];

function buildSafeEnv(bot: BotConfig): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ENV_WHITELIST) {
    if (process.env[key] != null) env[key] = process.env[key]!;
  }

  // Copy MOCOCO_* vars
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('MOCOCO_') && value != null) env[key] = value;
  }

  env.MOCOCO_BOT = bot.id;
  env.GIT_AUTHOR_NAME = bot.git.name;
  env.GIT_AUTHOR_EMAIL = bot.git.email;
  env.GIT_COMMITTER_NAME = bot.git.name;
  env.GIT_COMMITTER_EMAIL = bot.git.email;

  return env;
}

/**
 * Execute a task in a repo directory using claude --print.
 *
 * The repo's own CLAUDE.md and .claude/ settings are loaded natively
 * because cwd is set to the repo directory.
 *
 * Bot persona and repo worklog are injected via --append-system-prompt.
 */
export function executeInRepo(
  task: string,
  repoPath: string,
  systemPrompt: string,
  bot: BotConfig,
): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', task,
      '--model', bot.model,
      '--max-budget-usd', String(bot.maxBudget),
      '--dangerously-skip-permissions',
    ];

    if (systemPrompt) {
      args.push('--append-system-prompt', systemPrompt);
    }

    const child = spawn('claude', args, {
      cwd: repoPath,
      env: buildSafeEnv(bot),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ output: stdout.trim(), exitCode: -1 });
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT_SIZE) {
        truncated = true;
        console.warn(`[engine:${bot.id}] stdout exceeded limit, killing`);
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString();
        if (stderr.length > MAX_STDERR_BYTES) stderr = stderr.slice(0, MAX_STDERR_BYTES);
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      // Try to parse cost from stderr (claude CLI sometimes outputs it there)
      let costUsd: number | undefined;
      const costMatch = stderr.match(/total[_ ]cost[_ ]usd[:\s]+(\d+\.?\d*)/i);
      if (costMatch) costUsd = parseFloat(costMatch[1]);

      resolve({
        output: stdout.trim(),
        exitCode: code ?? 1,
        costUsd,
      });
    });
  });
}
