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
        // non-JSON line, ignore
      }
    });

    this.proc.on('exit', (code) => this.emit('exit', code));
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
