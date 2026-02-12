export type TeamId = string;

export type Engine = 'claude' | 'codex' | 'gemini';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface TeamConfig {
  id: TeamId;
  name: string;
  color: number;
  avatar: string;
  engine: Engine;
  model: string;
  maxBudget: number;
  prompt: string;
  isLeader?: boolean;
  channels?: string[];   // channel IDs — empty/omitted = all channels
  discordUserId?: string; // auto-populated on first login
  useTeams?: boolean;     // enable agent team mode for complex tasks
  teamRules?: string[];   // rules for how sub-agents are created and behave
  git: GitIdentity;
  discordToken: string;         // each team has its own Discord bot
  mcpServers?: Record<string, McpServerConfig>;
  permissions: {
    allow?: string[];
    deny?: string[];
  };
}

export interface TeamsConfig {
  teams: Record<string, TeamConfig>;
  globalDeny: string[];
  conversationWindow: number;
  workspacePath: string;
  humanDiscordId?: string;
}

export interface ConversationMessage {
  teamId: string | 'human';
  teamName: string;
  discordId?: string;
  content: string;
  timestamp: Date;
  mentions: string[];
}

export interface TeamInvocation {
  teamId: string;
  trigger: 'human_message' | 'team_mention' | 'direct_command';
  message: ConversationMessage;
  conversation: ConversationMessage[];
}

export interface EnvConfig {
  workChannelId?: string;
  hookPort: number;
  memberTrackingChannelId?: string;
  decisionLogChannelId?: string;
}

// ---------------------------------------------------------------------------
// Chain tracking — prevent infinite bot-to-bot loops
// ---------------------------------------------------------------------------

export interface ChainContext {
  chainId: string;
  totalInvocations: number;
  maxBudget: number;
  recentPath: string[];       // last N teamIds in this chain
}

// ---------------------------------------------------------------------------
// Dispatch ledger — track dispatched work for follow-up
// ---------------------------------------------------------------------------

export interface DispatchRecord {
  id: string;
  chainId: string;
  fromTeam: string;
  toTeam: string;
  channelId: string;
  reason: string;
  dispatchedAt: number;
  resolvedAt?: number;
  resolved: boolean;
}

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  mococo_team?: string;
  teammate_name?: string;
  task_subject?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}
