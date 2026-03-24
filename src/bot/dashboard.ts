import fs from 'node:fs';
import path from 'node:path';
import { EmbedBuilder, type Message, type ChatInputCommandInteraction } from 'discord.js';
import { getStatus } from '../teams/concurrency.js';
import { ledger } from '../teams/dispatch-ledger.js';
import { loadStressState, type StressState } from './stress-tracker.js';
import { formatTimeAgo } from './episode-writer.js';
import type { TeamsConfig, Episode } from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentMetrics {
  teamId: string;
  teamName: string;
  busy: boolean;
  currentTask?: string;
  busySince?: Date;
  completedCount: number;
  avgProcessingTimeMs: number;
  unresolvedDispatches: number;
  stressScore: number;
  stressLevel: number;
  recentEpisodeSummary?: string;
}

interface DashboardData {
  agents: AgentMetrics[];
  totalCompleted: number;
  totalInProgress: number;
  bottlenecks: string[];
}

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

function loadEpisodeMetrics(
  teamId: string,
  ws: string,
): { completedCount: number; avgProcessingTimeMs: number; recentSummary?: string } {
  const filePath = path.resolve(ws, '.mococo/memory', teamId, 'episodes.jsonl');
  let lines: string[];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    lines = content.split('\n').filter(l => l.trim());
  } catch {
    return { completedCount: 0, avgProcessingTimeMs: 0 };
  }

  const episodes: Episode[] = [];
  for (const line of lines) {
    try {
      const ep = JSON.parse(line) as Episode;
      if (typeof ep.ts === 'number' && !isNaN(ep.ts)) {
        episodes.push(ep);
      }
    } catch {
      // skip corrupted lines
    }
  }

  if (episodes.length === 0) {
    return { completedCount: 0, avgProcessingTimeMs: 0 };
  }

  // Estimate average processing time from gaps between consecutive episodes
  let totalGap = 0;
  let gapCount = 0;
  for (let i = 1; i < episodes.length; i++) {
    const gap = episodes[i].ts - episodes[i - 1].ts;
    if (gap > 0 && gap < 3_600_000) { // ignore gaps > 1 hour (idle periods)
      totalGap += gap;
      gapCount++;
    }
  }

  const avgMs = gapCount > 0 ? Math.round(totalGap / gapCount) : 0;
  const lastEp = episodes[episodes.length - 1];

  return {
    completedCount: episodes.length,
    avgProcessingTimeMs: avgMs,
    recentSummary: lastEp?.summary,
  };
}

function collectDashboardData(config: TeamsConfig): DashboardData {
  const status = getStatus();
  const unresolved = ledger.getUnresolved();
  const agents: AgentMetrics[] = [];

  let totalCompleted = 0;
  let totalInProgress = 0;
  const bottlenecks: string[] = [];

  for (const [_id, team] of Object.entries(config.teams)) {
    const teamStatus = status[team.id];
    const episodeMetrics = loadEpisodeMetrics(team.id, config.workspacePath);
    const stressState: StressState = loadStressState(config.workspacePath, team.id);
    const teamUnresolved = unresolved.filter(r => r.toTeam === team.id);

    const isBusy = !!teamStatus?.busy;

    const metrics: AgentMetrics = {
      teamId: team.id,
      teamName: team.name,
      busy: isBusy,
      currentTask: teamStatus?.task,
      busySince: teamStatus?.since,
      completedCount: episodeMetrics.completedCount,
      avgProcessingTimeMs: episodeMetrics.avgProcessingTimeMs,
      unresolvedDispatches: teamUnresolved.length,
      stressScore: stressState.score,
      stressLevel: stressState.level,
      recentEpisodeSummary: episodeMetrics.recentSummary,
    };

    agents.push(metrics);
    totalCompleted += episodeMetrics.completedCount;
    if (isBusy) totalInProgress++;

    // Detect bottlenecks: high stress OR many unresolved dispatches
    if (stressState.level >= 2) {
      bottlenecks.push(`${team.name}: stress level ${stressState.level}/3 (${stressState.score})`);
    }
    if (teamUnresolved.length >= 3) {
      bottlenecks.push(`${team.name}: ${teamUnresolved.length} unresolved dispatches`);
    }
  }

  return { agents, totalCompleted, totalInProgress, bottlenecks };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms <= 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes}m`;
}

const STRESS_EMOJI: Record<number, string> = {
  0: '\u{1F7E2}',
  1: '\u{1F7E1}',
  2: '\u{1F7E0}',
  3: '\u{1F534}',
};

function buildDashboardEmbeds(data: DashboardData): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];

  // --- Team-wide summary embed ---
  const summaryEmbed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('MOCOCO Dashboard')
    .setDescription('Team task status & progress visualization')
    .addFields(
      { name: 'Total Completed', value: `${data.totalCompleted}`, inline: true },
      { name: 'In Progress', value: `${data.totalInProgress}`, inline: true },
      { name: 'Agents', value: `${data.agents.length}`, inline: true },
    )
    .setTimestamp();

  if (data.bottlenecks.length > 0) {
    summaryEmbed.addFields({
      name: 'Bottlenecks',
      value: data.bottlenecks.map(b => `\u2022 ${b}`).join('\n'),
    });
  } else {
    summaryEmbed.addFields({
      name: 'Bottlenecks',
      value: 'None',
    });
  }

  embeds.push(summaryEmbed);

  // --- Per-agent detail embed ---
  const agentLines = data.agents.map(a => {
    const statusIcon = a.busy ? '\u{1F527}' : '\u{1F4A4}';
    const stressIcon = STRESS_EMOJI[a.stressLevel] ?? '\u26AA';
    const taskInfo = a.busy && a.currentTask ? ` \u2014 ${a.currentTask}` : '';
    const busyTime = a.busy && a.busySince
      ? ` (since ${formatTimeAgo(Date.now() - a.busySince.getTime())})`
      : '';
    const avgTime = a.avgProcessingTimeMs > 0 ? formatDuration(a.avgProcessingTimeMs) : '-';

    return [
      `${statusIcon} **${a.teamName}**${taskInfo}${busyTime}`,
      `  Done: ${a.completedCount} | Avg: ${avgTime} | ${stressIcon} Stress: ${a.stressScore}/100`,
      a.unresolvedDispatches > 0 ? `  Pending dispatches: ${a.unresolvedDispatches}` : '',
      a.recentEpisodeSummary ? `  Recent: ${a.recentEpisodeSummary.slice(0, 80)}` : '',
    ].filter(Boolean).join('\n');
  });

  const detailEmbed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('Agent Details')
    .setDescription(agentLines.join('\n\n') || 'No agents registered');

  embeds.push(detailEmbed);

  return embeds;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function handleDashboardCommand(
  msg: Message | ChatInputCommandInteraction,
  config: TeamsConfig,
): Promise<void> {
  const data = collectDashboardData(config);
  const embeds = buildDashboardEmbeds(data);
  if ('deferred' in msg && msg.deferred) {
    await (msg as ChatInputCommandInteraction).editReply({ embeds });
  } else {
    await msg.reply({ embeds });
  }
}

// ---------------------------------------------------------------------------
// Persist task metrics snapshot (optional, for historical tracking)
// ---------------------------------------------------------------------------

export function saveTaskMetrics(config: TeamsConfig): void {
  const data = collectDashboardData(config);
  const metricsPath = path.resolve(config.workspacePath, '.mococo/task-metrics.json');

  const snapshot = {
    timestamp: Date.now(),
    totalCompleted: data.totalCompleted,
    totalInProgress: data.totalInProgress,
    bottlenecks: data.bottlenecks,
    agents: data.agents.map(a => ({
      teamId: a.teamId,
      teamName: a.teamName,
      busy: a.busy,
      completedCount: a.completedCount,
      avgProcessingTimeMs: a.avgProcessingTimeMs,
      unresolvedDispatches: a.unresolvedDispatches,
      stressScore: a.stressScore,
      stressLevel: a.stressLevel,
    })),
  };

  try {
    fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
    fs.writeFileSync(metricsPath, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.warn('[dashboard] Failed to save task-metrics.json:', err);
  }
}
