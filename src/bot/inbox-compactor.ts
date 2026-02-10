import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isBusy } from '../teams/concurrency.js';
import type { TeamsConfig } from '../types.js';

const COMPACT_INTERVAL_MS = 30_000;
const COMPACT_THRESHOLD_CHARS = 3000;

function buildSummaryPrompt(teamName: string, inboxContent: string): string {
  return `You are summarizing an inbox for team member "${teamName}".
Extract only actionable information, decisions, and important context.
Discard greetings, reactions, and redundant messages.
Output a concise bullet list in Korean. Max 500 chars.

Inbox:
${inboxContent}`;
}

interface StreamJsonEvent {
  type: string;
  result?: string;
  [key: string]: unknown;
}

function runClaudeSummary(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p', prompt,
      '--model', 'haiku',
      '--max-turns', '1',
      '--output-format', 'stream-json',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let resultText = '';
    let buffer = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // stream-json outputs one JSON object per line
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as StreamJsonEvent;
          if (event.type === 'result' && event.result) {
            resultText = event.result;
          }
        } catch {
          // skip malformed lines
        }
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (resultText) {
        resolve(resultText);
      } else if (code === 0) {
        resolve('');
      } else {
        reject(new Error(`claude exited with code ${code}`));
      }
    });
  });
}

async function compactInbox(teamId: string, teamName: string, config: TeamsConfig): Promise<void> {
  const ws = config.workspacePath;
  const inboxPath = path.resolve(ws, '.mococo/inbox', `${teamId}.md`);

  let inboxContent: string;
  try {
    inboxContent = fs.readFileSync(inboxPath, 'utf-8').trim();
  } catch {
    return;
  }

  if (!inboxContent || inboxContent.length < COMPACT_THRESHOLD_CHARS) return;

  const prompt = buildSummaryPrompt(teamName, inboxContent);
  const summary = await runClaudeSummary(prompt);

  if (!summary) {
    console.warn(`[inbox-compactor] Empty summary for ${teamName}, skipping`);
    return;
  }

  // Append summary to short-term memory
  const memoryDir = path.resolve(ws, '.mococo/memory', teamId);
  fs.mkdirSync(memoryDir, { recursive: true });
  const shortTermPath = path.resolve(memoryDir, 'short-term.md');

  let existing = '';
  try {
    existing = fs.readFileSync(shortTermPath, 'utf-8').trim();
  } catch {
    // no existing short-term memory
  }

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const updated = existing
    ? `${existing}\n\n## Inbox Summary (${ts})\n${summary}`
    : `## Inbox Summary (${ts})\n${summary}`;
  fs.writeFileSync(shortTermPath, updated);

  // Delete inbox file
  try { fs.unlinkSync(inboxPath); } catch {}

  console.log(`[inbox-compactor] Compacted inbox for ${teamName} (${inboxContent.length} chars → ${summary.length} chars summary)`);
}

function checkInboxes(config: TeamsConfig): void {
  const inboxDir = path.resolve(config.workspacePath, '.mococo/inbox');
  if (!fs.existsSync(inboxDir)) return;

  for (const team of Object.values(config.teams)) {
    const inboxPath = path.resolve(inboxDir, `${team.id}.md`);

    let size: number;
    try {
      const stat = fs.statSync(inboxPath);
      size = stat.size;
    } catch {
      continue;
    }

    if (size < COMPACT_THRESHOLD_CHARS) continue;
    if (isBusy(team.id)) continue;

    // Fire and forget — errors are logged inside compactInbox
    compactInbox(team.id, team.name, config).catch(err => {
      console.error(`[inbox-compactor] Error compacting ${team.name}: ${err}`);
    });
  }
}

export function startInboxCompactor(config: TeamsConfig): void {
  console.log('[inbox-compactor] Started (interval: 30s, threshold: 3000 chars)');
  setInterval(() => checkInboxes(config), COMPACT_INTERVAL_MS);
}
