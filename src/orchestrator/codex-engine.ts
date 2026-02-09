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
      '--skip-git-repo-check',
      this.opts.prompt,
    ], {
      cwd: this.opts.cwd,
      env: this.getTeamEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
      console.error(`[codex:${this.opts.teamId}] spawn error: ${err.message}`);
    });

    this.proc.on('exit', (code) => {
      const output = messages.join('\n').trim();
      console.log(`[codex:${this.opts.teamId}] exited with code ${code} (output: ${output.length} chars)`);
      this.emit('result', { type: 'result', result: output, total_cost_usd: 0 });
      this.emit('exit', code);
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
