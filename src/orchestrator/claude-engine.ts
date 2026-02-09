import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { BaseEngine } from './engine-base.js';

export class ClaudeEngine extends BaseEngine {
  private proc: ChildProcess | null = null;

  async start(): Promise<void> {
    this.proc = spawn('claude', [
      '-p', this.opts.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.opts.model,
      '--dangerously-skip-permissions',
      '--max-budget-usd', String(this.opts.maxBudget),
    ], {
      cwd: this.opts.cwd,
      env: {
        ...this.getTeamEnv(),
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        this.emit('message', event);
        if (event.type === 'result') this.emit('result', event);
      } catch {
        // non-JSON line, log it
        console.log(`[claude:${this.opts.teamId}] stdout: ${line.slice(0, 200)}`);
      }
    });

    // Log stderr so we can see Claude errors
    const stderrRl = readline.createInterface({ input: this.proc.stderr! });
    stderrRl.on('line', (line) => {
      console.error(`[claude:${this.opts.teamId}] stderr: ${line.slice(0, 300)}`);
    });

    this.proc.on('exit', (code) => {
      console.log(`[claude:${this.opts.teamId}] exited with code ${code}`);
      this.emit('exit', code);
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
