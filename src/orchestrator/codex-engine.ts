import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { BaseEngine } from './engine-base.js';

export class CodexEngine extends BaseEngine {
  private proc: ChildProcess | null = null;

  async start(): Promise<void> {
    console.log(`[codex:${this.opts.teamId}] Starting codex (model: ${this.opts.model})`);

    this.proc = spawn('codex', [
      'exec',
      '-c', `model="${this.opts.model}"`,
      '--json',
      this.opts.prompt,
    ], {
      cwd: this.opts.cwd,
      env: this.getTeamEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastMessage = '';
    const stdoutRl = readline.createInterface({ input: this.proc.stdout! });
    stdoutRl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        // Capture the last assistant message as output
        if (event.type === 'message' && event.role === 'assistant') {
          lastMessage = typeof event.content === 'string'
            ? event.content
            : Array.isArray(event.content)
              ? event.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n')
              : '';
        }
      } catch {
        // non-JSON line
        console.log(`[codex:${this.opts.teamId}] stdout: ${line.slice(0, 200)}`);
      }
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
      console.log(`[codex:${this.opts.teamId}] exited with code ${code} (output: ${lastMessage.length} chars)`);
      this.emit('result', { type: 'result', result: lastMessage.trim(), total_cost_usd: 0 });
      this.emit('exit', code);
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
