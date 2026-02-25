import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { BaseEngine } from './engine-base.js';

const PROCESS_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SIGKILL_GRACE_MS = 10 * 1000;        // 10 seconds after SIGTERM

export class CodexEngine extends BaseEngine {
  private proc: ChildProcess | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  async start(): Promise<void> {
    console.log(`[codex:${this.opts.teamId}] Starting codex (model: ${this.opts.model})`);

    this.proc = spawn('codex', [
      'exec',
      '-c', `model="${this.opts.model}"`,
      '--json',
      '--skip-git-repo-check',
      this.opts.prompt,
    ], {
      cwd: this.opts.cwd,
      env: this.getTeamEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Process-level timeout: SIGTERM → SIGKILL escalation
    this.timeoutTimer = setTimeout(() => {
      if (this.proc && !this.proc.killed) {
        console.warn(`[codex:${this.opts.teamId}] process timeout (${PROCESS_TIMEOUT_MS / 1000}s) — sending SIGTERM`);
        this.proc.kill('SIGTERM');
        this.killTimer = setTimeout(() => {
          if (this.proc && !this.proc.killed) {
            console.warn(`[codex:${this.opts.teamId}] SIGTERM grace period expired — sending SIGKILL`);
            this.proc.kill('SIGKILL');
          }
        }, SIGKILL_GRACE_MS);
      }
    }, PROCESS_TIMEOUT_MS);

    const messages: string[] = [];
    const stdoutRl = readline.createInterface({ input: this.proc.stdout! });
    stdoutRl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        // Codex outputs agent_message items with the response text
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          messages.push(event.item.text);
        }
      } catch {
        // non-JSON line
      }
    });

    // Log stderr
    const stderrRl = readline.createInterface({ input: this.proc.stderr! });
    stderrRl.on('line', (line) => {
      console.error(`[codex:${this.opts.teamId}] stderr: ${line.slice(0, 300)}`);
    });

    this.proc.on('error', (err) => {
      this.clearTimers();
      stdoutRl.close();
      stderrRl.close();
      console.error(`[codex:${this.opts.teamId}] spawn error: ${err.message}`);
    });

    this.proc.on('exit', (code) => {
      this.clearTimers();
      stdoutRl.close();
      stderrRl.close();
      const output = messages.join('\n').trim();
      console.log(`[codex:${this.opts.teamId}] exited with code ${code} (output: ${output.length} chars)`);
      this.emit('result', { type: 'result', result: output, total_cost_usd: 0 });
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
