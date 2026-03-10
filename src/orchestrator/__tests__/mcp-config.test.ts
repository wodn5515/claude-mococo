import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../utils/fs.js', () => ({
  atomicWriteSync: vi.fn(),
}));

import { writeMcpConfig } from '../mcp-config.js';
import { atomicWriteSync } from '../../utils/fs.js';

describe('writeMcpConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes stdio MCP server config', () => {
    writeMcpConfig('test-team', {
      notion: {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: { TOKEN: 'abc' },
      },
    }, tmpDir);

    const [filePath, content] = (atomicWriteSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filePath).toContain('test-team.json');
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.notion).toEqual({
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { TOKEN: 'abc' },
    });
  });

  it('writes HTTP MCP server config', () => {
    writeMcpConfig('test-team', {
      figma: {
        type: 'http',
        url: 'https://mcp.figma.com/mcp',
        headers: { 'X-Figma-Token': 'figd_test123' },
      },
    }, tmpDir);

    const [filePath, content] = (atomicWriteSync as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filePath).toContain('test-team.json');
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.figma).toEqual({
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
      headers: { 'X-Figma-Token': 'figd_test123' },
    });
  });

  it('writes mixed stdio and HTTP servers together', () => {
    writeMcpConfig('test-team', {
      notion: {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
      },
      figma: {
        type: 'http',
        url: 'https://mcp.figma.com/mcp',
        headers: { 'X-Figma-Token': 'token123' },
      },
    }, tmpDir);

    const [, content] = (atomicWriteSync as ReturnType<typeof vi.fn>).mock.calls[0];
    const parsed = JSON.parse(content);
    expect(parsed.mcpServers.notion.command).toBe('npx');
    expect(parsed.mcpServers.figma.type).toBe('http');
    expect(parsed.mcpServers.figma.url).toBe('https://mcp.figma.com/mcp');
  });
});
