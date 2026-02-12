import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireWorkspace } from '../workspace.js';

export async function runDev(): Promise<void> {
  const ws = requireWorkspace();

  // Resolve the project root (where package.json lives)
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(thisFile), '..', '..', '..');

  console.log('mococo dev — watching src/ for changes (auto-rebuild + restart)');
  console.log(`Workspace: ${ws}`);
  console.log('Press Ctrl+C to stop.\n');

  const child = spawn(
    'npx',
    [
      'nodemon',
      '--watch', path.join(projectRoot, 'src'),
      '--ext', 'ts,json',
      '--exec', `npm run build --prefix "${projectRoot}" && node "${path.join(projectRoot, 'dist', 'cli', 'index.js')}" start`,
    ],
    {
      cwd: ws,
      stdio: 'inherit',
      shell: true,
    },
  );

  child.on('error', (err) => {
    console.error(`Failed to start dev mode: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
}
