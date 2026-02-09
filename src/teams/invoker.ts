import { createEngine } from '../orchestrator/engines.js';
import { buildTeamPrompt } from '../orchestrator/prompt-builder.js';
import { findMentionedTeams } from '../bot/router.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

export interface InvocationResult {
  teamId: string;
  output: string;
  cost: number;
  mentions: string[];
}

export async function invokeTeam(
  team: TeamConfig,
  invocation: TeamInvocation,
  config: TeamsConfig,
): Promise<InvocationResult> {
  const prompt = await buildTeamPrompt(team, invocation, config);

  const engine = createEngine(team.engine, {
    prompt,
    cwd: config.workspacePath,
    model: team.model,
    maxBudget: team.maxBudget,
    teamId: team.id,
    gitName: team.git.name,
    gitEmail: team.git.email,
    githubToken: team.githubToken,
  });

  return new Promise((resolve, reject) => {
    let resolved = false;

    engine.on('result', (event) => {
      resolved = true;
      const output = event.result ?? '';
      const mentionedTeams = findMentionedTeams(output, config);
      resolve({
        teamId: team.id,
        output,
        cost: event.total_cost_usd ?? 0,
        mentions: mentionedTeams.map(t => t.id),
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
