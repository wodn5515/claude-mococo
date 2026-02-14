import path from 'node:path';
import fs from 'node:fs';
import type { McpServerConfig } from '../types.js';
import { atomicWriteSync } from '../utils/fs.js';

export function writeMcpConfig(
  teamId: string,
  servers: Record<string, McpServerConfig>,
  cwd: string,
): string {
  const mcpDir = path.resolve(cwd, '.mococo', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const filePath = path.join(mcpDir, `${teamId}.json`);
  const config = { mcpServers: servers };
  atomicWriteSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

export function cleanupMcpConfig(teamId: string, cwd: string): void {
  const filePath = path.resolve(cwd, '.mococo', 'mcp', `${teamId}.json`);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already removed — ignore
  }
}
