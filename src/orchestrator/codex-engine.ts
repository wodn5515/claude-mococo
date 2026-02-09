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

    let lastMessage = '';
    const stdoutRl = readline.createInterface({ input: this.proc.stdout! });
    stdoutRl.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        console.log(`[codex:${this.opts.teamId}] event: ${JSON.stringify(event).slice(0, 300)}`);
        // Try multiple formats to capture the final assistant message
        if (event.type === 'message' && event.role === 'assistant') {
          const text = typeof event.content === 'string'
            ? event.content
            : Array.isArray(event.content)
              ? event.content.filter((c: any) => c.type === 'text' || c.type === 'output_text').map((c: any) => c.text).join('\n')
              : '';
          if (text) lastMessage = text;
        }
        // Also check for response/output fields
        if (event.type === 'response' && event.output) {
          lastMessage = typeof event.output === 'string' ? event.output : JSON.stringify(event.output);
        }
        if (event.message) {
          const msg = typeof event.message === 'string' ? event.message : '';
          if (msg) lastMessage = msg;
        }
      } catch {
        // non-JSON line — might be plain text output
        const trimmed = line.trim();
        if (trimmed) {
          console.log(`[codex:${this.opts.teamId}] text: ${trimmed.slice(0, 200)}`);
          lastMessage = trimmed;
        }
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
