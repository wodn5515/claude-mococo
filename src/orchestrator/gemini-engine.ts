import { spawn, type ChildProcess } from 'node:child_process';
import { BaseEngine } from './engine-base.js';

export class GeminiEngine extends BaseEngine {
  private proc: ChildProcess | null = null;

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

    let stdout = '';
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    this.proc.on('error', (err) => {
      console.error(`[GeminiEngine] process error: ${err.message}`);
      this.emit('result', { type: 'result', result: `[GeminiEngine] process error: ${err.message}`, total_cost_usd: 0 });
      this.emit('exit', 1);
    });

    this.proc.on('exit', (code) => {
      this.emit('result', { type: 'result', result: stdout.trim(), total_cost_usd: 0 });
      this.emit('exit', code);
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
