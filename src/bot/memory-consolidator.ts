import fs from 'node:fs';
import path from 'node:path';
import { runHaiku } from '../utils/haiku.js';
import { isBusy } from '../teams/concurrency.js';
import type { TeamsConfig } from '../types.js';

const CONSOLIDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function buildConsolidatePrompt(teamName: string, shortTerm: string, longTerm: string): string {
  return `You are consolidating memory for team member "${teamName}".

## Current Long-term Memory
${longTerm || '(empty)'}

## Current Short-term Memory
${shortTerm || '(empty)'}

## Task
Review the short-term memory and make these decisions for each piece of information:
1. **Promote to long-term**: User preferences, project structure, recurring patterns, key decisions, team capabilities, important facts that will be needed long-term
2. **Keep in short-term**: Active tasks, current blockers, temporary context needed for upcoming work, completed tasks that still provide useful context for ongoing work
3. **Remove**: Truly obsolete info with no future relevance, stale context that no longer matters, duplicates of what's already in long-term

Output EXACTLY this format (include both sections even if empty):

---LONG-TERM---
(full updated long-term memory content - existing + newly promoted items, in Korean bullet list)
---END-LONG-TERM---

---SHORT-TERM---
(cleaned short-term memory - only active/relevant items, in Korean bullet list)
---END-SHORT-TERM---`;
}

function parseConsolidateResult(stdout: string): { longTerm: string; shortTerm: string } | null {
  const longMatch = stdout.match(/---LONG-TERM---\n([\s\S]*?)\n---END-LONG-TERM---/);
  const shortMatch = stdout.match(/---SHORT-TERM---\n([\s\S]*?)\n---END-SHORT-TERM---/);

  if (!longMatch && !shortMatch) {
    console.warn(`[memory-consolidator] Could not parse output, skipping`);
    return null;
  }

  return {
    longTerm: longMatch?.[1]?.trim() ?? '',
    shortTerm: shortMatch?.[1]?.trim() ?? '',
  };
}

async function consolidateTeam(teamId: string, teamName: string, config: TeamsConfig): Promise<void> {
  const ws = config.workspacePath;
  const memoryDir = path.resolve(ws, '.mococo/memory', teamId);
  const shortTermPath = path.resolve(memoryDir, 'short-term.md');
  const longTermPath = path.resolve(memoryDir, 'long-term.md');

  let shortTerm = '';
  let longTerm = '';
  try { shortTerm = fs.readFileSync(shortTermPath, 'utf-8').trim(); } catch {}
  try { longTerm = fs.readFileSync(longTermPath, 'utf-8').trim(); } catch {}

  if (!shortTerm) return;

  const prompt = buildConsolidatePrompt(teamName, shortTerm, longTerm);
  const output = await runHaiku(prompt);
  const result = parseConsolidateResult(output);
  if (!result) return;

  fs.mkdirSync(memoryDir, { recursive: true });

  if (result.longTerm) {
    fs.writeFileSync(longTermPath, result.longTerm);
  }
  fs.writeFileSync(shortTermPath, result.shortTerm);

  const promoted = result.longTerm && result.longTerm !== longTerm;
  console.log(`[memory-consolidator] Consolidated ${teamName}: short-term ${shortTerm.length}→${result.shortTerm.length} chars${promoted ? ', promoted items to long-term' : ''}`);
}

function checkMemories(config: TeamsConfig): void {
  for (const team of Object.values(config.teams)) {
    if (isBusy(team.id)) continue;

    consolidateTeam(team.id, team.name, config).catch(err => {
      console.error(`[memory-consolidator] Error consolidating ${team.name}: ${err}`);
    });
  }
}

export function startMemoryConsolidator(config: TeamsConfig): void {
  console.log('[memory-consolidator] Started (interval: 6h)');
  setTimeout(() => {
    checkMemories(config);
    setInterval(() => checkMemories(config), CONSOLIDATE_INTERVAL_MS);
  }, 60_000);
}
