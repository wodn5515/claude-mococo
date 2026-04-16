import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from '../types.js';
import {
  loadBotConfig,
  saveBotConfig,
  savePersona,
  saveBotMemory,
  botDir,
} from '../config.js';
import type { BotConfig, TriageSelfModify } from '../types.js';

/**
 * Extract content between delimiters from the original user message.
 * Supports ---PERSONA---, ---MEMORY---, ```persona, ```memory code blocks, etc.
 */
function extractDelimitedContent(originalMessage: string, target: string): string | null {
  const upperTarget = target.toUpperCase();

  // Try ---TARGET--- ... ---END-TARGET--- first
  const blockRegex = new RegExp(
    `---${upperTarget}---([\\s\\S]*?)---END-${upperTarget}---`,
    'i',
  );
  const blockMatch = originalMessage.match(blockRegex);
  if (blockMatch) return blockMatch[1].trim();

  // Try fenced code block: ```persona ... ```
  const fenceRegex = new RegExp(
    `\\\`\\\`\\\`${target}\\s*\\n?([\\s\\S]*?)\\n?\\\`\\\`\\\``,
    'i',
  );
  const fenceMatch = originalMessage.match(fenceRegex);
  if (fenceMatch) return fenceMatch[1].trim();

  return null;
}

/**
 * Apply a self-modify operation to the bot's config/persona/memory.
 * `originalMessage` is the raw Discord message — used to extract delimited
 * content for large values (persona/memory) that are unreliable via JSON.
 * Returns a status message describing what was changed.
 */
export function applySelfModify(
  botId: string,
  op: TriageSelfModify,
  originalMessage: string,
): string {
  const config = loadBotConfig(botId);

  // For persona/memory large-content ops, try to extract from delimiters in the
  // original message — this bypasses fragile JSON escaping in the LLM output.
  if ((op.target === 'persona' || op.target === 'memory')
      && (op.operation === 'replace' || op.operation === 'append')
      && typeof op.value !== 'string') {
    const extracted = extractDelimitedContent(originalMessage, op.target);
    if (extracted) {
      op = { ...op, value: extracted };
    }
  }

  // Also prefer delimiter content if LLM value looks suspicious (empty or malformed)
  if ((op.target === 'persona' || op.target === 'memory')
      && (op.operation === 'replace' || op.operation === 'append')
      && (!op.value || (typeof op.value === 'string' && op.value.length < 20))) {
    const extracted = extractDelimitedContent(originalMessage, op.target);
    if (extracted && extracted.length > 20) {
      op = { ...op, value: extracted };
    }
  }

  switch (op.target) {
    case 'persona':
      return modifyPersona(botId, op);
    case 'memory':
      return modifyMemory(botId, op);
    case 'allowedDirs':
      return modifyAllowedDirs(botId, config, op);
    case 'schedule':
      return modifySchedule(botId, config, op);
    case 'permissions':
      return modifyPermissions(botId, config, op);
    default:
      throw new Error(`Unknown self-modify target: ${(op as any).target}`);
  }
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

function modifyPersona(botId: string, op: TriageSelfModify): string {
  const personaPath = path.join(botDir(botId), 'persona.md');
  const current = fs.existsSync(personaPath) ? fs.readFileSync(personaPath, 'utf-8') : '';

  if (op.operation === 'replace') {
    if (typeof op.value !== 'string') throw new Error('replace requires string value');
    savePersona(botId, op.value);
    return 'persona.md replaced';
  }

  if (op.operation === 'append') {
    if (typeof op.value !== 'string') throw new Error('append requires string value');
    const next = current.trimEnd() + '\n\n' + op.value.trim() + '\n';
    savePersona(botId, next);
    return `persona.md updated (appended ${op.value.length} chars)`;
  }

  if (op.operation === 'clear') {
    savePersona(botId, '');
    return 'persona.md cleared';
  }

  throw new Error(`persona does not support operation: ${op.operation}`);
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

function modifyMemory(botId: string, op: TriageSelfModify): string {
  if (op.operation === 'clear') {
    saveBotMemory(botId, '');
    return 'memory.md cleared';
  }

  if (op.operation === 'replace') {
    if (typeof op.value !== 'string') throw new Error('replace requires string value');
    saveBotMemory(botId, op.value);
    return 'memory.md replaced';
  }

  if (op.operation === 'append') {
    if (typeof op.value !== 'string') throw new Error('append requires string value');
    const memPath = path.join(botDir(botId), 'memory.md');
    const current = fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : '';
    const next = current.trimEnd() + '\n' + op.value.trim() + '\n';
    saveBotMemory(botId, next);
    return `memory.md updated (appended)`;
  }

  throw new Error(`memory does not support operation: ${op.operation}`);
}

// ---------------------------------------------------------------------------
// allowedDirs
// ---------------------------------------------------------------------------

function modifyAllowedDirs(botId: string, config: BotConfig, op: TriageSelfModify): string {
  let dirs = [...config.allowedDirs];

  if (op.operation === 'add') {
    const toAdd = typeof op.value === 'string' ? [op.value] : (op.value as string[]);
    if (!Array.isArray(toAdd)) throw new Error('add requires string or string[]');

    for (const d of toAdd) {
      const resolved = d === '*' ? '*' : path.resolve(d);
      if (!dirs.includes(resolved)) {
        dirs.push(resolved);
        // Ensure repo memory dir exists for this path
        if (resolved !== '*') {
          const repoName = path.basename(resolved);
          const repoMemDir = path.join(MOCOCO_HOME, 'repos', repoName);
          fs.mkdirSync(repoMemDir, { recursive: true });
          const ctxPath = path.join(repoMemDir, 'context.md');
          const wlPath = path.join(repoMemDir, 'worklog.md');
          if (!fs.existsSync(ctxPath)) fs.writeFileSync(ctxPath, '');
          if (!fs.existsSync(wlPath)) fs.writeFileSync(wlPath, '');
        }
      }
    }
  } else if (op.operation === 'remove') {
    const toRemove = typeof op.value === 'string' ? [op.value] : (op.value as string[]);
    if (!Array.isArray(toRemove)) throw new Error('remove requires string or string[]');
    const resolvedRemove = toRemove.map(d => d === '*' ? '*' : path.resolve(d));
    dirs = dirs.filter(d => !resolvedRemove.includes(d));
  } else if (op.operation === 'set') {
    if (!Array.isArray(op.value)) throw new Error('set requires string[]');
    dirs = (op.value as string[]).map(d => d === '*' ? '*' : path.resolve(d));
  } else {
    throw new Error(`allowedDirs does not support operation: ${op.operation}`);
  }

  const { id: _, ...rest } = config;
  saveBotConfig(botId, { ...rest, allowedDirs: dirs });
  return `allowedDirs: ${dirs.length} entries`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function modifySchedule(botId: string, config: BotConfig, op: TriageSelfModify): string {
  if (op.operation === 'clear') {
    const { id: _, schedule: __, ...rest } = config;
    saveBotConfig(botId, rest);
    return 'schedule cleared (requires bot restart to take effect)';
  }

  if (op.operation === 'set') {
    if (typeof op.value !== 'object' || Array.isArray(op.value)) {
      throw new Error('schedule set requires object');
    }
    const { id: _, ...rest } = config;
    saveBotConfig(botId, { ...rest, schedule: op.value as any });
    return 'schedule updated (requires bot restart to take effect)';
  }

  throw new Error(`schedule does not support operation: ${op.operation}`);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function modifyPermissions(botId: string, config: BotConfig, op: TriageSelfModify): string {
  const current = config.permissions || {};

  if (op.operation === 'set') {
    if (typeof op.value !== 'object' || Array.isArray(op.value)) {
      throw new Error('permissions set requires object with allow/deny');
    }
    const { id: _, ...rest } = config;
    saveBotConfig(botId, { ...rest, permissions: op.value as any });
    return 'permissions replaced';
  }

  if (op.operation === 'add' || op.operation === 'remove') {
    const val = op.value as { allow?: string[]; deny?: string[] };
    const next = {
      allow: [...(current.allow || [])],
      deny: [...(current.deny || [])],
    };

    if (op.operation === 'add') {
      if (val.allow) next.allow.push(...val.allow.filter(a => !next.allow.includes(a)));
      if (val.deny) next.deny.push(...val.deny.filter(d => !next.deny.includes(d)));
    } else {
      if (val.allow) next.allow = next.allow.filter(a => !val.allow!.includes(a));
      if (val.deny) next.deny = next.deny.filter(d => !val.deny!.includes(d));
    }

    const { id: _, ...rest } = config;
    saveBotConfig(botId, { ...rest, permissions: next });
    return `permissions: allow=${next.allow.length}, deny=${next.deny.length}`;
  }

  throw new Error(`permissions does not support operation: ${op.operation}`);
}
