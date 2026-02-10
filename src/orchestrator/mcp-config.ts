import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '../types.js';

export function writeMcpConfig(
  teamId: string,
  servers: Record<string, McpServerConfig>,
  cwd: string,
): string {
  const mcpDir = path.resolve(cwd, '.mococo', 'mcp');
  fs.mkdirSync(mcpDir, { recursive: true });
  const filePath = path.join(mcpDir, `${teamId}.json`);
  const config = { mcpServers: servers };
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
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
