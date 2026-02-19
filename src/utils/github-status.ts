import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PRInfo {
  owner: string;
  repo: string;
  number: number;
}

export interface PRStatus extends PRInfo {
  state: 'open' | 'closed';
  merged: boolean;
  title: string;
}

// ---------------------------------------------------------------------------
// Repo discovery — read git remotes from repos/ directory
// ---------------------------------------------------------------------------

export function discoverRepos(workspacePath: string): Map<string, { owner: string; repo: string }> {
  const reposDir = path.resolve(workspacePath, 'repos');
  const result = new Map<string, { owner: string; repo: string }>();

  try {
    const entries = fs.readdirSync(reposDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const gitConfigPath = path.join(reposDir, entry.name, '.git', 'config');
      try {
        const gitConfig = fs.readFileSync(gitConfigPath, 'utf-8');
        // Match both HTTPS and SSH remotes
        const urlMatch = gitConfig.match(
          /url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s.]+)/,
        );
        if (urlMatch) {
          result.set(entry.name, { owner: urlMatch[1], repo: urlMatch[2] });
        }
      } catch { /* no git config */ }
    }
  } catch { /* no repos dir */ }

  return result;
}

// ---------------------------------------------------------------------------
// PR reference extraction from memory text
// ---------------------------------------------------------------------------

export function extractPRs(
  content: string,
  repos: Map<string, { owner: string; repo: string }>,
): PRInfo[] {
  const prs: PRInfo[] = [];
  const seen = new Set<string>();

  // 1. Match full GitHub URLs: github.com/owner/repo/pull/N
  const urlRegex = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g;
  let match;
  while ((match = urlRegex.exec(content)) !== null) {
    const key = `${match[1]}/${match[2]}#${match[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      prs.push({ owner: match[1], repo: match[2], number: parseInt(match[3]) });
    }
  }

  // 2. Match bare PR #N — resolve against known repos
  const bareRegex = /PR\s*#(\d+)/gi;
  while ((match = bareRegex.exec(content)) !== null) {
    const num = parseInt(match[1]);
    // Skip if already found via URL
    if (prs.some(p => p.number === num)) continue;
    // Add for each known repo (API will confirm which one has it)
    for (const [, info] of repos) {
      const key = `${info.owner}/${info.repo}#${num}`;
      if (!seen.has(key)) {
        seen.add(key);
        prs.push({ owner: info.owner, repo: info.repo, number: num });
      }
    }
  }

  return prs;
}

// ---------------------------------------------------------------------------
// GitHub API — check actual PR statuses
// ---------------------------------------------------------------------------

export async function checkPRStatuses(prs: PRInfo[]): Promise<PRStatus[]> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.warn('[github-status] No GITHUB_TOKEN or GH_TOKEN — skipping PR status check');
    return [];
  }
  if (prs.length === 0) return [];

  const results: PRStatus[] = [];

  for (const pr of prs) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );

      if (res.status === 404) continue; // PR doesn't exist in this repo
      if (!res.ok) {
        console.warn(`[github-status] API error for ${pr.owner}/${pr.repo}#${pr.number}: ${res.status}`);
        continue;
      }

      const data = (await res.json()) as { state: string; merged: boolean; title: string };
      results.push({
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
        state: data.state as 'open' | 'closed',
        merged: data.merged ?? false,
        title: data.title,
      });
    } catch (err) {
      console.warn(`[github-status] Error checking ${pr.owner}/${pr.repo}#${pr.number}:`, err);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Format status report for system message
// ---------------------------------------------------------------------------

export function formatPRStatusReport(statuses: PRStatus[]): string {
  if (statuses.length === 0) return '';

  const lines = statuses.map(s => {
    const stateText = s.merged
      ? '✅ merged'
      : s.state === 'closed'
        ? '❌ closed'
        : '🔵 open';
    return `- ${s.owner}/${s.repo} PR #${s.number}: ${stateText} — ${s.title}`;
  });

  return `\n\n**GitHub PR 실제 상태 (API 조회 결과):**\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// High-level: check all PR statuses referenced in team memories
// ---------------------------------------------------------------------------

export async function verifyPRStatuses(workspacePath: string, teamIds: string[]): Promise<{
  statuses: PRStatus[];
  report: string;
}> {
  const repos = discoverRepos(workspacePath);
  if (repos.size === 0) {
    return { statuses: [], report: '' };
  }

  // Collect PR references from all team memories
  const allPRs: PRInfo[] = [];
  const seen = new Set<string>();

  for (const teamId of teamIds) {
    const shortTermPath = path.resolve(workspacePath, '.mococo/memory', teamId, 'short-term.md');
    try {
      const stm = fs.readFileSync(shortTermPath, 'utf-8');
      for (const pr of extractPRs(stm, repos)) {
        const key = `${pr.owner}/${pr.repo}#${pr.number}`;
        if (!seen.has(key)) {
          seen.add(key);
          allPRs.push(pr);
        }
      }
    } catch { /* no memory file */ }
  }

  if (allPRs.length === 0) {
    return { statuses: [], report: '' };
  }

  console.log(`[github-status] Checking ${allPRs.length} PR(s) across ${repos.size} repo(s)...`);
  const statuses = await checkPRStatuses(allPRs);
  const report = formatPRStatusReport(statuses);

  if (statuses.length > 0) {
    console.log(`[github-status] Verified ${statuses.length} PR(s):`,
      statuses.map(s => `${s.owner}/${s.repo}#${s.number}=${s.merged ? 'merged' : s.state}`).join(', '));
  }

  return { statuses, report };
}
