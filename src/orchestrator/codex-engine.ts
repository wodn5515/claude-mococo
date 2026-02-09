import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { BaseEngine } from './engine-base.js';

export class CodexEngine extends BaseEngine {
  private proc: ChildProcess | null = null;

  async start(): Promise<void> {
    console.log(`[codex:${this.opts.teamId}] Starting codex (model: ${this.opts.model})`);

    this.proc = spawn('codex', [
      '--quiet',
      '--full-auto',
      '--model', this.opts.model,
      '-p', this.opts.prompt,
    ], {
      cwd: this.opts.cwd,
      env: this.getTeamEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Log stderr
    const stderrRl = readline.createInterface({ input: this.proc.stderr! });
    stderrRl.on('line', (line) => {
      console.error(`[codex:${this.opts.teamId}] stderr: ${line.slice(0, 300)}`);
    });

    this.proc.on('error', (err) => {
      console.error(`[codex:${this.opts.teamId}] spawn error: ${err.message}`);
    });

    this.proc.on('exit', (code) => {
      console.log(`[codex:${this.opts.teamId}] exited with code ${code} (stdout: ${stdout.length} chars)`);
      this.emit('result', { type: 'result', result: stdout.trim(), total_cost_usd: 0 });
      this.emit('exit', code);
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
