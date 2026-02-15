import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { BaseEngine } from './engine-base.js';
import { writeMcpConfig, cleanupMcpConfig } from './mcp-config.js';

export class ClaudeEngine extends BaseEngine {
  private proc: ChildProcess | null = null;
  private mcpConfigPath: string | null = null;

  async start(): Promise<void> {
    const args = [
      '-p', this.opts.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.opts.model,
      '--dangerously-skip-permissions',
      '--max-budget-usd', String(this.opts.maxBudget),
    ];

    if (this.opts.mcpServers && Object.keys(this.opts.mcpServers).length > 0) {
      this.mcpConfigPath = writeMcpConfig(this.opts.teamId, this.opts.mcpServers, this.opts.cwd);
      args.push('--mcp-config', this.mcpConfigPath);
    }

    this.proc = spawn('claude', args, {
      cwd: this.opts.cwd,
      env: {
        ...this.getTeamEnv(),
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Track both readline close and process exit to avoid race conditions.
    // The 'result' event may arrive in the last stdout line — readline must
    // finish processing before we emit 'exit', otherwise the invoker rejects
    // the promise before the result is received.
    let exitCode: number | null = null;
    let rlClosed = false;
    let procExited = false;

    const maybeEmitExit = () => {
      if (rlClosed && procExited) {
        if (this.mcpConfigPath) cleanupMcpConfig(this.opts.teamId, this.opts.cwd);
        this.emit('exit', exitCode);
      }
    };

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
    rl.on('close', () => {
      rlClosed = true;
      maybeEmitExit();
    });

    // Log stderr so we can see Claude errors
    const stderrRl = readline.createInterface({ input: this.proc.stderr! });
    stderrRl.on('line', (line) => {
      console.error(`[claude:${this.opts.teamId}] stderr: ${line.slice(0, 300)}`);
    });

    this.proc.on('error', (err) => {
      console.error(`[claude:${this.opts.teamId}] spawn error: ${err.message}`);
      if (!procExited) {
        exitCode = 1;
        procExited = true;
        rlClosed = true;
        maybeEmitExit();
      }
    });

    this.proc.on('exit', (code) => {
      console.log(`[claude:${this.opts.teamId}] exited with code ${code}`);
      exitCode = code;
      procExited = true;
      maybeEmitExit();
    });
  }

  kill() {
    this.proc?.kill('SIGTERM');
  }
}
