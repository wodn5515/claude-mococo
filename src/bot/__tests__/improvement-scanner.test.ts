import { describe, it, expect } from 'vitest';

import { isTestFile, buildScanPrompt, parseHaikuOutput, issueKey } from '../improvement-scanner.js';

// ---------------------------------------------------------------------------
// isTestFile
// ---------------------------------------------------------------------------

describe('isTestFile', () => {
  it('detects Python test files', () => {
    expect(isTestFile('tests/test_auth.py')).toBe(true);
    expect(isTestFile('backend/tests/test_share_link_use_case.py')).toBe(true);
    expect(isTestFile('test_something.py')).toBe(true);
    expect(isTestFile('backend/app/auth_test.py')).toBe(true);
  });

  it('detects conftest.py', () => {
    expect(isTestFile('tests/conftest.py')).toBe(true);
    expect(isTestFile('conftest.py')).toBe(true);
  });

  it('detects TypeScript/JS test files', () => {
    expect(isTestFile('src/bot/__tests__/foo.test.ts')).toBe(true);
    expect(isTestFile('utils/helper.spec.js')).toBe(true);
    expect(isTestFile('src/foo.test.js')).toBe(true);
  });

  it('detects test directories', () => {
    expect(isTestFile('tests/helpers/factory.py')).toBe(true);
    expect(isTestFile('src/__tests__/setup.ts')).toBe(true);
    expect(isTestFile('test/fixtures/data.json')).toBe(true);
  });

  it('does NOT flag production files', () => {
    expect(isTestFile('src/bot/client.ts')).toBe(false);
    expect(isTestFile('backend/app/services/auth.py')).toBe(false);
    expect(isTestFile('utils/haiku.ts')).toBe(false);
    expect(isTestFile('backend/app/models/property.py')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseHaikuOutput — evidence-based filtering
// ---------------------------------------------------------------------------

describe('parseHaikuOutput', () => {
  it('accepts issues with line and evidence', () => {
    const output = JSON.stringify([
      {
        file: 'src/app.ts',
        repo: 'test-repo',
        type: 'security',
        severity: 'high',
        line: 42,
        evidence: 'const secret = "hardcoded"',
        description: '하드코딩된 시크릿',
        suggestion: '환경변수로 이동',
      },
    ]);
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(42);
    expect(result[0].evidence).toBe('const secret = "hardcoded"');
  });

  it('discards issues without line number', () => {
    const output = JSON.stringify([
      {
        file: 'src/app.ts',
        repo: 'test-repo',
        type: 'security',
        severity: 'high',
        description: '추론 기반 이슈',
        suggestion: '확인 필요',
      },
    ]);
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(0);
  });

  it('discards issues with line=0', () => {
    const output = JSON.stringify([
      {
        file: 'src/app.ts',
        repo: 'test-repo',
        type: 'security',
        severity: 'medium',
        line: 0,
        evidence: 'some code',
        description: '라인 0 이슈',
        suggestion: '수정 필요',
      },
    ]);
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(0);
  });

  it('discards issues without evidence', () => {
    const output = JSON.stringify([
      {
        file: 'src/app.ts',
        repo: 'test-repo',
        type: 'performance',
        severity: 'medium',
        line: 15,
        evidence: '',
        description: '증거 없는 이슈',
        suggestion: '확인 필요',
      },
    ]);
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(0);
  });

  it('handles markdown-fenced JSON', () => {
    const output = '```json\n' + JSON.stringify([
      {
        file: 'src/app.ts',
        repo: 'test-repo',
        type: 'refactoring',
        severity: 'low',
        line: 10,
        evidence: 'duplicateCode()',
        description: '중복 코드',
        suggestion: '함수 추출',
      },
    ]) + '\n```';
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseHaikuOutput('not json at all')).toEqual([]);
    expect(parseHaikuOutput('')).toEqual([]);
  });

  it('filters mixed valid and invalid items', () => {
    const output = JSON.stringify([
      {
        file: 'src/good.ts',
        repo: 'test-repo',
        type: 'security',
        severity: 'high',
        line: 5,
        evidence: 'eval(userInput)',
        description: '유효한 이슈',
        suggestion: '수정 필요',
      },
      {
        file: 'src/bad.ts',
        repo: 'test-repo',
        type: 'security',
        severity: 'high',
        description: '라인 없는 이슈',
        suggestion: '추론',
      },
      {
        file: 'src/also-bad.ts',
        repo: 'test-repo',
        type: 'unknown-type',
        severity: 'high',
        line: 1,
        evidence: 'code',
        description: '잘못된 타입',
        suggestion: '수정',
      },
    ]);
    const result = parseHaikuOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe('src/good.ts');
  });
});

// ---------------------------------------------------------------------------
// buildScanPrompt — test file tagging & evidence rules
// ---------------------------------------------------------------------------

describe('buildScanPrompt', () => {
  it('tags test files with [TEST FILE]', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/app.ts', content: 'const x = 1;' },
      { filePath: 'tests/conftest.py', content: 'import pytest' },
      { filePath: 'tests/test_auth.py', content: 'def test_login(): pass' },
    ]);
    expect(prompt).toContain('src/app.ts');
    expect(prompt).not.toContain('src/app.ts [TEST FILE]');
    expect(prompt).toContain('tests/conftest.py [TEST FILE]');
    expect(prompt).toContain('tests/test_auth.py [TEST FILE]');
  });

  it('includes evidence-based analysis rules', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'console.log("hello");' },
    ]);
    expect(prompt).toContain('Evidence-Based Analysis Rules');
    expect(prompt).toContain('"line"');
    expect(prompt).toContain('"evidence"');
    expect(prompt).toContain('false positives');
  });

  it('includes false positive prevention for test files', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'code' },
    ]);
    expect(prompt).toContain('Hardcoded values in test files');
    expect(prompt).toContain('test fixtures, not production secrets');
  });

  it('includes N+1 query false positive prevention', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'code' },
    ]);
    expect(prompt).toContain('scalars().all()');
    expect(prompt).toContain('N+1');
  });

  it('includes async false positive prevention', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'code' },
    ]);
    expect(prompt).toContain('AsyncClient');
  });

  it('includes confidence threshold', () => {
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'code' },
    ]);
    expect(prompt).toContain('80%');
  });

  it('includes existing issues to prevent re-reporting', () => {
    const existing = [{
      file: 'src/old.ts',
      repo: 'my-repo',
      type: 'security' as const,
      severity: 'high' as const,
      description: '기존 이슈',
      suggestion: '수정 필요',
    }];
    const prompt = buildScanPrompt('my-repo', [
      { filePath: 'src/main.ts', content: 'code' },
    ], existing);
    expect(prompt).toContain('Previously Reported Issues');
    expect(prompt).toContain('기존 이슈');
  });
});

// ---------------------------------------------------------------------------
// issueKey
// ---------------------------------------------------------------------------

describe('issueKey', () => {
  it('generates consistent keys', () => {
    const issue = { file: 'src/app.ts', repo: 'my-repo', type: 'security', description: 'test' };
    expect(issueKey(issue)).toBe('my-repo::src/app.ts::security::test');
  });

  it('normalizes JSON-escaped repo names', () => {
    const k1 = issueKey({ file: 'a.ts', repo: 'my-repo', type: 'security', description: 'x' });
    const k2 = issueKey({ file: 'a.ts', repo: 'my\\u002Drepo', type: 'security', description: 'x' });
    expect(k1).toBe(k2);
  });
});
