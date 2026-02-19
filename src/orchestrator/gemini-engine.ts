import { spawn, type ChildProcess } from 'node:child_process';
import { BaseEngine } from './engine-base.js';

const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SIGKILL_GRACE_MS = 10 * 1000;        // 10 seconds after SIGTERM

export class GeminiEngine extends BaseEngine {
  private proc: ChildProcess | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    try {
      this.proc = spawn('gemini', [
        '-p', this.opts.prompt,
        '--model', this.opts.model,
      ], {
        cwd: this.opts.cwd,
        env: this.getTeamEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.emit('result', { type: 'result', result: `[GeminiEngine] spawn failed: ${err instanceof Error ? err.message : err}`, total_cost_usd: 0 });
      this.emit('exit', 1);
      return;
    }

    // Process-level timeout: SIGTERM → SIGKILL escalation
    this.timeoutTimer = setTimeout(() => {
      if (this.proc && !this.proc.killed) {
        console.warn(`[gemini:${this.opts.teamId}] process timeout (${PROCESS_TIMEOUT_MS / 1000}s) — sending SIGTERM`);
        this.proc.kill('SIGTERM');
        this.killTimer = setTimeout(() => {
          if (this.proc && !this.proc.killed) {
            console.warn(`[gemini:${this.opts.teamId}] SIGTERM grace period expired — sending SIGKILL`);
            this.proc.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
      }
    }, PROCESS_TIMEOUT_MS);

    const MAX_STDOUT = 5 * 1024 * 1024; // 5MB
    let stdout = '';
    let stdoutTruncated = false;
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT) {
        stdoutTruncated = true;
        stdout = stdout.slice(0, MAX_STDOUT);
        console.warn(`[gemini:${this.opts.teamId}] stdout truncated at ${MAX_STDOUT} bytes`);
        this.proc?.kill('SIGTERM');
      }
    });

    this.proc.on('error', (err) => {
      this.clearTimers();
      console.error(`[gemini:${this.opts.teamId}] process error: ${err.message}`);
      this.emit('result', { type: 'result', result: `[GeminiEngine] process error: ${err.message}`, total_cost_usd: 0 });
      this.emit('exit', 1);
    });

    this.proc.on('exit', (code) => {
      this.clearTimers();
      this.emit('result', { type: 'result', result: stdout.trim(), total_cost_usd: 0 });
      this.emit('exit', code);
    });
  }

  kill() {
    this.clearTimers();
    this.proc?.kill('SIGTERM');
  }

  private clearTimers() {
    if (this.timeoutTimer) { clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
  }
}
