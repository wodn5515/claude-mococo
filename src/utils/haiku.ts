import { spawn } from 'node:child_process';

const MAX_STDOUT_SIZE = 5 * 1024 * 1024; // 5MB limit

/**
 * Run a prompt through claude CLI with haiku model (single turn).
 * Shared utility — used by inbox-compactor, memory-consolidator, improvement-scanner.
 */
export function runHaiku(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--model', 'haiku',
      '--max-turns', '1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let truncated = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      stdout += chunk.toString();
      if (stdout.length > MAX_STDOUT_SIZE) {
        truncated = true;
        console.warn(`[haiku] stdout exceeded ${MAX_STDOUT_SIZE} bytes, killing process`);
        child.kill('SIGTERM');
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0 || truncated) {
        resolve(stdout.trim().slice(0, MAX_STDOUT_SIZE));
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
