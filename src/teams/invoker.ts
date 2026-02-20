import { createEngine } from '../orchestrator/engines.js';
import { buildTeamPrompt } from '../orchestrator/prompt-builder.js';
import type { TeamConfig, TeamsConfig, TeamInvocation } from '../types.js';

const INVOKE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — safety net above engine-level timeout

export interface InvocationResult {
  teamId: string;
  output: string;
  cost: number;
  timedOut?: boolean;
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

  // Track last known cost from engine messages so timeout can report actual spend
  let lastKnownCost = 0;
  engine.on('message', (event) => {
    if (typeof event.total_cost_usd === 'number') {
      lastKnownCost = event.total_cost_usd;
    }
  });

  const enginePromise = new Promise<InvocationResult>((resolve, reject) => {
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

  const timeoutPromise = new Promise<InvocationResult>((resolve) => {
    setTimeout(() => {
      engine.kill();
      console.warn(`[${team.id}] Timed out after ${INVOKE_TIMEOUT_MS / 1000}s (cost so far: $${lastKnownCost.toFixed(4)}) — returning partial result for continuation`);
      resolve({
        teamId: team.id,
        output: '',
        cost: lastKnownCost,
        timedOut: true,
      });
    }, INVOKE_TIMEOUT_MS);
  });

  return Promise.race([enginePromise, timeoutPromise]);
}
