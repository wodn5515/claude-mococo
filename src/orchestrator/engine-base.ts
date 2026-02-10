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
  githubToken: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export abstract class BaseEngine extends EventEmitter {
  constructor(protected opts: EngineOptions) {
    super();
  }
  abstract start(): Promise<void>;
  abstract kill(): void;

  /** Common env vars for all engines: git identity + GitHub token */
  protected getTeamEnv(): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      MOCOCO_TEAM: this.opts.teamId,
      GIT_AUTHOR_NAME: this.opts.gitName,
      GIT_AUTHOR_EMAIL: this.opts.gitEmail,
      GIT_COMMITTER_NAME: this.opts.gitName,
      GIT_COMMITTER_EMAIL: this.opts.gitEmail,
    };
    // Set GH_TOKEN so gh CLI and git push use this team's GitHub account
    if (this.opts.githubToken) {
      env.GH_TOKEN = this.opts.githubToken;
      env.GITHUB_TOKEN = this.opts.githubToken;
    }
    return env;
  }
}
