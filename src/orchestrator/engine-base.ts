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

  /** Common env vars for all engines: git identity */
  protected getTeamEnv(): Record<string, string> {
    return {
      ...process.env as Record<string, string>,
      MOCOCO_TEAM: this.opts.teamId,
      GIT_AUTHOR_NAME: this.opts.gitName,
      GIT_AUTHOR_EMAIL: this.opts.gitEmail,
      GIT_COMMITTER_NAME: this.opts.gitName,
      GIT_COMMITTER_EMAIL: this.opts.gitEmail,
    };
  }
}
