import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MOCOCO_HOME = path.join(os.homedir(), '.mococo');

// ---------------------------------------------------------------------------
// Engine types
// ---------------------------------------------------------------------------

export type Engine = 'claude' | 'codex' | 'gemini';

// ---------------------------------------------------------------------------
// Bot config (per-bot, stored in ~/.mococo/bots/<id>/config.json)
// ---------------------------------------------------------------------------

export interface GitIdentity {
  name: string;
  email: string;
}

export interface ScheduleConfig {
  cron?: string;                    // Cron expression (e.g. "0 */2 * * *" = every 2h)
  onIdle?: boolean;                 // Auto-trigger when idle for idleDelayMinutes
  idleDelayMinutes?: number;        // Minutes of idle before auto-trigger (default: 10)
  reportChannel?: string;           // Discord channel ID to post scheduled results
}

export interface BotConfig {
  id: string;
  name: string;                     // Display name (e.g. "스택코코")
  engine: Engine;
  model: string;                    // e.g. "sonnet", "opus", "o3"
  color?: string;                   // Hex color for Discord embeds
  avatar?: string;                  // Avatar URL or built-in key
  maxBudget: number;                // Max $ per invocation (claude only)
  discordTokenEnv: string;          // Env var name for Discord token
  discordUserId?: string;           // Auto-populated on first login
  isLeader?: boolean;               // Responds to all messages without @mention
  channels?: string[];              // Restrict to specific channel IDs
  allowedDirs: string[];            // Directories this bot can access
  permissions: {
    allow?: string[];
    deny?: string[];
  };
  git: GitIdentity;
  schedule?: ScheduleConfig;        // Cron/idle auto-trigger settings
}

// ---------------------------------------------------------------------------
// Global config (stored in ~/.mococo/global.json)
// ---------------------------------------------------------------------------

export interface GlobalConfig {
  humanDiscordId?: string;
  humanTitle?: string;              // How bots address the human (default: "Boss")
  globalDeny: string[];             // Commands denied across all bots
  conversationWindow: number;       // Recent Discord messages in context
}

// ---------------------------------------------------------------------------
// Triage — Phase 1 decision
// ---------------------------------------------------------------------------

export interface TriageRepoWork {
  action: 'repo_work';
  repo: string;                     // Absolute path to repo
  repoName: string;                 // Display name
  task: string;                     // Task description for claude
}

export interface TriageReply {
  action: 'reply';
  message: string;                  // Direct Discord response
}

export interface TriageIgnore {
  action: 'ignore';
}

export type TriageResult = TriageRepoWork | TriageReply | TriageIgnore;

// ---------------------------------------------------------------------------
// Repo context (loaded from ~/.mococo/repos/<name>/)
// ---------------------------------------------------------------------------

export interface RepoInfo {
  name: string;
  path: string;                     // Absolute path
  context: string;                  // context.md content
  worklogSummary: string;           // Recent worklog entries (truncated)
}

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  output: string;                   // claude's text output
  exitCode: number;
  costUsd?: number;                 // If parseable from output
}

// ---------------------------------------------------------------------------
// Discord message (simplified)
// ---------------------------------------------------------------------------

export interface DiscordMessage {
  content: string;
  authorId: string;
  authorName: string;
  channelId: string;
  isBot: boolean;
}
