import { spawn, type ChildProcess } from 'node:child_process';
import { BaseEngine } from './engine-base.js';

export class GeminiEngine extends BaseEngine {
  private proc: ChildProcess | null = null;

  async start(): Promise<void> {
    this.proc = spawn('gemini', [
      '-p', this.opts.prompt,
      '--model', this.opts.model,
    ], {
      cwd: this.opts.cwd,
      env: this.getTeamEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
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
