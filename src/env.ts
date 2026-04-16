import fs from 'node:fs';
import path from 'node:path';
import { MOCOCO_HOME } from './types.js';

/**
 * Load environment variables from ~/.mococo/.env if it exists.
 * Simple parser: KEY=value, KEY="value with spaces", # comments.
 * Does not override variables already set in process.env.
 */
export function loadEnvFile(): void {
  const envPath = path.join(MOCOCO_HOME, '.env');

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return; // No .env file, nothing to load
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
