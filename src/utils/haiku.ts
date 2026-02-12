import { spawn } from 'node:child_process';

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

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}
