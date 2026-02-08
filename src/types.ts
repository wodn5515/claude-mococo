export type TeamId = string;

export type Engine = 'claude' | 'codex' | 'gemini';

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
  git: GitIdentity;
  discordToken: string;         // each team has its own Discord bot
  githubToken: string;          // each team has its own GitHub account
  permissions: {
    allow?: string[];
    deny?: string[];
  };
}

export interface TeamsConfig {
  teams: Record<string, TeamConfig>;
  globalDeny: string[];
  conversationWindow: number;
}

export interface ConversationMessage {
  teamId: string | 'human';
  teamName: string;
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
  workChannelId: string;
  hookPort: number;
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
