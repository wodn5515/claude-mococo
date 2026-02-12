import fs from 'node:fs';
import path from 'node:path';
import type { TeamsConfig, TeamConfig, McpServerConfig } from './types.js';

const AVATAR_MAP: Record<string, string> = {
  crown: 'https://em-content.zobj.net/source/apple/391/crown_1f451.png',
  brain: 'https://em-content.zobj.net/source/apple/391/brain_1f9e0.png',
  gear: 'https://em-content.zobj.net/source/apple/391/gear_2699-fe0f.png',
  palette: 'https://em-content.zobj.net/source/apple/391/artist-palette_1f3a8.png',
  shield: 'https://em-content.zobj.net/source/apple/391/shield_1f6e1-fe0f.png',
  eye: 'https://em-content.zobj.net/source/apple/391/eye_1f441-fe0f.png',
  robot: 'https://em-content.zobj.net/source/apple/391/robot_1f916.png',
  test: 'https://em-content.zobj.net/source/apple/391/test-tube_1f9ea.png',
  book: 'https://em-content.zobj.net/source/apple/391/books_1f4da.png',
};

export function loadTeamsConfig(workspacePath: string = process.cwd()): TeamsConfig {
  const teamsJsonPath = path.resolve(workspacePath, 'teams.json');

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(teamsJsonPath, 'utf-8'));
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`[config] teams.json not found at ${teamsJsonPath}`);
      console.error('[config] Run "mococo init" first to create a workspace.');
      process.exit(1);
    }
    throw err;
  }

  const teams: Record<string, TeamConfig> = {};

  for (const [id, cfg] of Object.entries(raw.teams as Record<string, any>)) {
    // Resolve Discord token: read env var name from config
    const discordTokenEnv = cfg.discordTokenEnv ?? `${id.toUpperCase()}_DISCORD_TOKEN`;
    const discordToken = process.env[discordTokenEnv] ?? '';
    if (!discordToken) {
      console.warn(`[config] Missing env var ${discordTokenEnv} for team "${id}" — bot will not start`);
    }

    // Resolve MCP server configs: expand $VAR references in env values
    let mcpServers: Record<string, McpServerConfig> | undefined;
    if (cfg.mcpServers) {
      mcpServers = {};
      for (const [name, server] of Object.entries(cfg.mcpServers as Record<string, any>)) {
        const resolvedEnv: Record<string, string> = {};
        if (server.env) {
          for (const [key, val] of Object.entries(server.env as Record<string, string>)) {
            resolvedEnv[key] = val.startsWith('$')
              ? (process.env[val.slice(1)] ?? '')
              : val;
          }
        }
        mcpServers[name] = {
          command: server.command,
          args: server.args,
          env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
        };
      }
    }

    teams[id] = {
      id,
      name: cfg.name,
      color: parseInt(cfg.color.replace('#', ''), 16),
      avatar: AVATAR_MAP[cfg.avatar] ?? cfg.avatar,
      engine: cfg.engine ?? 'claude',
      model: cfg.model ?? 'sonnet',
      maxBudget: cfg.maxBudget ?? 10,
      prompt: cfg.prompt,
      isLeader: cfg.isLeader ?? false,
      channels: cfg.channels,
      discordUserId: cfg.discordUserId,
      useTeams: cfg.useTeams ?? false,
      teamRules: cfg.teamRules,
      git: cfg.git ?? {
        name: `${cfg.name} (mococo)`,
        email: `mococo-${id}@users.noreply.github.com`,
      },
      discordToken,
      mcpServers,
      permissions: cfg.permissions ?? {},
    };
  }

  return {
    teams,
    globalDeny: raw.globalDeny ?? [],
    conversationWindow: raw.conversationWindow ?? 30,
    workspacePath,
    humanDiscordId: raw.humanDiscordId,
  };
}

export function getLeaderTeam(config: TeamsConfig): TeamConfig | undefined {
  return Object.values(config.teams).find(t => t.isLeader);
}
