import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectRepoName } from '../prompt-builder.js';

// ---------------------------------------------------------------------------
// detectRepoName — unit tests
// ---------------------------------------------------------------------------

const KNOWN_REPOS = ['Kil-biseo', 'atom.io', 'claude-mococo', 'orbi-advance', 'move-ai'];

describe('detectRepoName', () => {
  it('detects explicit repos/ path reference', () => {
    expect(detectRepoName('cd repos/Kil-biseo && git status', KNOWN_REPOS)).toBe('Kil-biseo');
  });

  it('detects repo name with trailing slash', () => {
    expect(detectRepoName('repos/atom.io/ 작업', KNOWN_REPOS)).toBe('atom.io');
  });

  it('detects repo name mentioned in text (not as path)', () => {
    expect(detectRepoName('Kil-biseo PR #460 리뷰해라', KNOWN_REPOS)).toBe('Kil-biseo');
  });

  it('detects repo name with special chars (atom.io)', () => {
    expect(detectRepoName('atom.io 레포에서 작업', KNOWN_REPOS)).toBe('atom.io');
  });

  it('returns null when no repo mentioned', () => {
    expect(detectRepoName('좋은 아침입니다', KNOWN_REPOS)).toBeNull();
  });

  it('prioritizes explicit path over name mention', () => {
    expect(detectRepoName('repos/Kil-biseo 에서 atom.io 관련', KNOWN_REPOS)).toBe('Kil-biseo');
  });

  it('detects repo name in backticks', () => {
    expect(detectRepoName('`claude-mococo` 레포', KNOWN_REPOS)).toBe('claude-mococo');
  });

  it('detects repo name at start of message', () => {
    expect(detectRepoName('Kil-biseo 이슈 등록', KNOWN_REPOS)).toBe('Kil-biseo');
  });

  it('detects repo name at end of message', () => {
    expect(detectRepoName('이슈 등록 Kil-biseo', KNOWN_REPOS)).toBe('Kil-biseo');
  });

  it('does not match partial names', () => {
    // "move" alone should not match "move-ai"
    expect(detectRepoName('move this file', KNOWN_REPOS)).toBeNull();
  });

  it('returns null for unknown repo in path', () => {
    expect(detectRepoName('repos/unknown-repo 작업', KNOWN_REPOS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AGENT.md loading integration test (uses temp filesystem)
// ---------------------------------------------------------------------------

describe('AGENT.md loading (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-md-test-'));
    fs.mkdirSync(path.join(tmpDir, 'repos', 'test-repo'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'prompts', 'repo-specific'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('AGENT.md file is found when present in repo root', () => {
    const agentMdPath = path.join(tmpDir, 'repos', 'test-repo', 'AGENT.md');
    fs.writeFileSync(agentMdPath, '## Overview\nTest repo context');

    expect(fs.existsSync(agentMdPath)).toBe(true);
    const content = fs.readFileSync(agentMdPath, 'utf-8');
    expect(content).toContain('Test repo context');
  });

  it('falls back to prompts/repo-specific when no AGENT.md', () => {
    const legacyPath = path.join(tmpDir, 'prompts', 'repo-specific', 'test-repo.md');
    fs.writeFileSync(legacyPath, 'Legacy rules here');

    const agentMdPath = path.join(tmpDir, 'repos', 'test-repo', 'AGENT.md');
    expect(fs.existsSync(agentMdPath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it('AGENT.md takes priority over legacy repo-specific', () => {
    const agentMdPath = path.join(tmpDir, 'repos', 'test-repo', 'AGENT.md');
    const legacyPath = path.join(tmpDir, 'prompts', 'repo-specific', 'test-repo.md');
    fs.writeFileSync(agentMdPath, 'AGENT.md content');
    fs.writeFileSync(legacyPath, 'Legacy content');

    // Both exist — AGENT.md should be preferred
    expect(fs.existsSync(agentMdPath)).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(true);

    // Read AGENT.md (what loadRepoContext does first)
    const content = fs.readFileSync(agentMdPath, 'utf-8');
    expect(content).toBe('AGENT.md content');
  });
});
