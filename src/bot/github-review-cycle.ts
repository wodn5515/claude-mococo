import { execSync } from 'node:child_process';
import { hookEvents } from '../server/hook-receiver.js';
import { addMessage } from '../teams/context.js';
import type { TeamsConfig, TeamConfig, EnvConfig, ConversationMessage, ChainContext } from '../types.js';

// ---------------------------------------------------------------------------
// GitHub PR Review Cycle
//
// Automates the review loop between developer teams and the review team:
//   1. PR opened/synchronized → notify review team for code review
//   2. PR review submitted    → notify PR author team to address feedback
// ---------------------------------------------------------------------------

type HandleTeamInvocation = (
  team: TeamConfig,
  triggerMsg: ConversationMessage,
  channelId: string,
  config: TeamsConfig,
  env: EnvConfig,
  chain: ChainContext,
) => void;

type NewChainFn = () => ChainContext;

function findReviewTeam(config: TeamsConfig): TeamConfig | undefined {
  return Object.values(config.teams).find(t => t.id === 'review');
}

/**
 * Match a team by the commit author email in the PR's head commit.
 * Falls back to the first non-leader, non-review team if lookup fails.
 */
function findTeamByCommitEmail(
  repoFullName: string,
  sha: string,
  config: TeamsConfig,
): TeamConfig | undefined {
  try {
    const email = execSync(
      `gh api repos/${repoFullName}/commits/${sha} --jq '.commit.author.email'`,
      { encoding: 'utf-8', timeout: 10_000 },
    ).trim();

    const match = Object.values(config.teams).find(t => t.git.email === email);
    if (match) return match;
  } catch (err) {
    console.warn('[github-review-cycle] Failed to lookup commit author:', err instanceof Error ? err.message : err);
  }

  // Fallback: first non-leader, non-review team
  return Object.values(config.teams).find(t => !t.isLeader && t.id !== 'review');
}

export function startGitHubReviewCycle(
  config: TeamsConfig,
  env: EnvConfig,
  handleInvocation: HandleTeamInvocation,
  newChain: NewChainFn,
) {
  const channelId = env.workChannelId;
  if (!channelId) {
    console.log('[github-review-cycle] No WORK_CHANNEL_ID — skipping setup');
    return;
  }

  hookEvents.on('github', (data: { event: string; payload: any }) => {
    try {
      if (data.event === 'pull_request') {
        handlePREvent(data.payload, config, env, handleInvocation, newChain, channelId);
      } else if (data.event === 'pull_request_review') {
        handleReviewEvent(data.payload, config, env, handleInvocation, newChain, channelId);
      }
    } catch (err) {
      console.error('[github-review-cycle] Unhandled error:', err);
    }
  });

  console.log('[github-review-cycle] Listening for GitHub PR events');
}

// ---------------------------------------------------------------------------
// PR opened / synchronized → notify review team
// ---------------------------------------------------------------------------

function handlePREvent(
  payload: any,
  config: TeamsConfig,
  env: EnvConfig,
  handleInvocation: HandleTeamInvocation,
  newChain: NewChainFn,
  channelId: string,
) {
  const action = payload.action;
  if (action !== 'opened' && action !== 'synchronize') return;

  const reviewTeam = findReviewTeam(config);
  if (!reviewTeam) {
    console.warn('[github-review-cycle] No review team configured');
    return;
  }

  const pr = payload.pull_request;
  const repo = payload.repository.full_name;
  const actionLabel = action === 'opened' ? 'PR 오픈' : '새 커밋 푸시';

  // Try to identify who authored the PR
  let authorHint = '';
  const authorTeam = findTeamByCommitEmail(repo, pr.head.sha, config);
  if (authorTeam) {
    authorHint = `\n작성자: ${authorTeam.name}`;
  }

  const content = [
    `[GitHub ${actionLabel}] ${repo}#${pr.number} — "${pr.title}"`,
    `PR: ${pr.html_url}`,
    `브랜치: ${pr.head.ref}${authorHint}`,
    `→ 코드를 리뷰하고 GitHub에 리뷰 코멘트를 남겨주세요.`,
  ].join('\n');

  const triggerMsg: ConversationMessage = {
    teamId: 'system',
    teamName: 'System',
    content,
    timestamp: new Date(),
    mentions: [reviewTeam.id],
  };

  addMessage(channelId, triggerMsg);
  handleInvocation(reviewTeam, triggerMsg, channelId, config, env, newChain());
  console.log(`[github-review-cycle] ${actionLabel}: ${repo}#${pr.number} → ${reviewTeam.name}`);
}

// ---------------------------------------------------------------------------
// PR review submitted → notify PR author team
// ---------------------------------------------------------------------------

function handleReviewEvent(
  payload: any,
  config: TeamsConfig,
  env: EnvConfig,
  handleInvocation: HandleTeamInvocation,
  newChain: NewChainFn,
  channelId: string,
) {
  if (payload.action !== 'submitted') return;

  const review = payload.review;
  const pr = payload.pull_request;
  const repo = payload.repository.full_name;

  // Find the PR author team by commit email
  const authorTeam = findTeamByCommitEmail(repo, pr.head.sha, config);
  if (!authorTeam) {
    console.warn('[github-review-cycle] Could not determine PR author team');
    return;
  }

  // Skip if the author IS the review team (self-review)
  if (authorTeam.id === 'review') return;

  const stateLabel =
    review.state === 'approved' ? '승인' :
    review.state === 'changes_requested' ? '변경 요청' :
    '코멘트';

  const content = [
    `[GitHub 리뷰 — ${stateLabel}] ${repo}#${pr.number} — "${pr.title}"`,
    `리뷰: ${review.html_url}`,
    ...(review.body ? [`내용: ${review.body.slice(0, 500)}`] : []),
    `→ 리뷰 피드백을 확인하고 수정을 반영한 후 푸시해주세요.`,
  ].join('\n');

  const triggerMsg: ConversationMessage = {
    teamId: 'system',
    teamName: 'System',
    content,
    timestamp: new Date(),
    mentions: [authorTeam.id],
  };

  addMessage(channelId, triggerMsg);
  handleInvocation(authorTeam, triggerMsg, channelId, config, env, newChain());
  console.log(`[github-review-cycle] Review ${stateLabel}: ${repo}#${pr.number} → ${authorTeam.name}`);
}
