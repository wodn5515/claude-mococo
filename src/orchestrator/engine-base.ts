import { EventEmitter } from 'node:events';
import type { McpServerConfig } from '../types.js';

export interface EngineOptions {
  prompt: string;
  cwd: string;
  model: string;
  maxBudget: number;
  teamId: string;
  gitName: string;
  gitEmail: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export abstract class BaseEngine extends EventEmitter {
  constructor(protected opts: EngineOptions) {
    super();
  }
  abstract start(): Promise<void>;
  abstract kill(): void;

  /** Whitelist of env vars safe to pass to child processes */
  private static readonly ENV_WHITELIST = [
    // System basics
    'PATH', 'HOME', 'SHELL', 'USER', 'LANG', 'TERM', 'NODE_ENV',
    // API keys for AI engines
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    // Git / GitHub
    'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN',
    // Temp directories
    'TMPDIR', 'TMP', 'TEMP',
    // XDG config
    'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
    // Terminal output
    'NO_COLOR', 'FORCE_COLOR',
    // Proxy settings
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  ] as const;

  /** Common env vars for all engines: git identity + safe subset of env */
  protected getTeamEnv(): Record<string, string> {
    const env: Record<string, string> = {};

    // Copy only whitelisted env vars
    for (const key of BaseEngine.ENV_WHITELIST) {
      if (process.env[key] != null) {
        env[key] = process.env[key]!;
      }
    }

    // Copy all MOCOCO_* env vars
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('MOCOCO_') && value != null) {
        env[key] = value;
      }
    }

    // Explicit overrides
    env.MOCOCO_TEAM = this.opts.teamId;
    env.GIT_AUTHOR_NAME = this.opts.gitName;
    env.GIT_AUTHOR_EMAIL = this.opts.gitEmail;
    env.GIT_COMMITTER_NAME = this.opts.gitName;
    env.GIT_COMMITTER_EMAIL = this.opts.gitEmail;

    return env;
  }
}
