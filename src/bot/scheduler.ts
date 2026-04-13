import type { ScheduleConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Minimal cron parser (supports: */N, specific values, * wildcard)
// Fields: minute hour day-of-month month day-of-week
// ---------------------------------------------------------------------------

interface CronFields {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === '*') {
    return Array.from({ length: max - min + 1 }, (_, i) => i + min);
  }

  // */N — every N
  const stepMatch = field.match(/^\*\/(\d+)$/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]);
    const values: number[] = [];
    for (let i = min; i <= max; i += step) values.push(i);
    return values;
  }

  // Comma-separated values and ranges
  const values: number[] = [];
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      for (let i = start; i <= end; i++) values.push(i);
    } else {
      values.push(parseInt(part));
    }
  }
  return values.filter(v => v >= min && v <= max);
}

function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dayOfMonth: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dayOfWeek: parseField(parts[4], 0, 6),
  };
}

function cronMatches(fields: CronFields, date: Date): boolean {
  return (
    fields.minute.includes(date.getMinutes()) &&
    fields.hour.includes(date.getHours()) &&
    fields.dayOfMonth.includes(date.getDate()) &&
    fields.month.includes(date.getMonth() + 1) &&
    fields.dayOfWeek.includes(date.getDay())
  );
}

// ---------------------------------------------------------------------------
// Scheduler — manages cron + idle triggers for a bot
// ---------------------------------------------------------------------------

export type ScheduleCallback = (trigger: 'cron' | 'idle') => Promise<void>;

export class Scheduler {
  private cronFields: CronFields | null = null;
  private cronTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastActivity: number = Date.now();
  private running = false;
  private stopped = false;

  constructor(
    private config: ScheduleConfig,
    private botName: string,
    private callback: ScheduleCallback,
  ) {
    if (config.cron) {
      this.cronFields = parseCron(config.cron);
      if (!this.cronFields) {
        console.warn(`[${botName}:scheduler] Invalid cron expression: ${config.cron}`);
      }
    }
  }

  start(): void {
    // Cron: check every minute
    if (this.cronFields) {
      console.log(`[${this.botName}:scheduler] Cron enabled: ${this.config.cron}`);
      this.cronTimer = setInterval(() => this.checkCron(), 60_000);
    }

    // Idle: start tracking
    if (this.config.onIdle) {
      const delay = (this.config.idleDelayMinutes ?? 10) * 60_000;
      console.log(`[${this.botName}:scheduler] Idle trigger enabled: ${delay / 60_000}min`);
      this.resetIdleTimer();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.cronTimer) clearInterval(this.cronTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** Call this whenever the bot processes a Discord message */
  notifyActivity(): void {
    this.lastActivity = Date.now();
    this.resetIdleTimer();
  }

  /** Call this when the bot finishes a scheduled task */
  notifyTaskComplete(): void {
    this.running = false;
    this.resetIdleTimer();
  }

  private async checkCron(): Promise<void> {
    if (this.stopped || this.running || !this.cronFields) return;

    const now = new Date();
    if (cronMatches(this.cronFields, now)) {
      console.log(`[${this.botName}:scheduler] Cron triggered at ${now.toISOString()}`);
      this.running = true;
      try {
        await this.callback('cron');
      } catch (err) {
        console.error(`[${this.botName}:scheduler] Cron task error:`, err);
      } finally {
        this.running = false;
      }
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.stopped || !this.config.onIdle) return;

    const delay = (this.config.idleDelayMinutes ?? 10) * 60_000;
    this.idleTimer = setTimeout(() => this.onIdle(), delay);
  }

  private async onIdle(): Promise<void> {
    if (this.stopped || this.running) {
      this.resetIdleTimer();
      return;
    }

    console.log(`[${this.botName}:scheduler] Idle triggered (no activity for ${this.config.idleDelayMinutes ?? 10}min)`);
    this.running = true;
    try {
      await this.callback('idle');
    } catch (err) {
      console.error(`[${this.botName}:scheduler] Idle task error:`, err);
    } finally {
      this.running = false;
      // Reset idle timer for next cycle
      this.resetIdleTimer();
    }
  }
}
