import { createEngine } from '../orchestrator/engines.js';
import { buildTeamPrompt } from '../orchestrator/prompt-builder.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

export interface InvocationResult {
  teamId: string;
  output: string;
  cost: number;
}

export async function invokeTeam(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
  preloadedInbox?: string,
): Promise<InvocationResult> {
  const prompt = await buildTeamPrompt(team, invocation, config, preloadedInbox);

  const engine = createEngine(team.engine, {
    prompt,
    cwd: config.workspacePath,
    model: team.model,
    maxBudget: team.maxBudget,
    teamId: team.id,
    gitName: team.git.name,
    gitEmail: team.git.email,
    mcpServers: team.mcpServers,
  });

  return new Promise((resolve, reject) => {
    let resolved = false;

    engine.on('result', (event) => {
      resolved = true;
      resolve({
        teamId: team.id,
        output: event.result ?? '',
        cost: event.total_cost_usd ?? 0,
      });
    });

    engine.on('exit', (code) => {
      if (!resolved) {
        reject(new Error(`Team ${team.id} (${team.engine}) exited with code ${code}`));
      }
    });

    engine.start().catch(reject);
  });
}
