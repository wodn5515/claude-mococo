import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireWorkspace } from '../workspace.js';

export async function runDev(): Promise<void> {
  const ws = requireWorkspace();

  // Resolve the project root (where package.json lives)
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(thisFile), '..', '..', '..');

  // Ensure .restart-trigger exists
  const triggerFile = path.join(projectRoot, '.restart-trigger');
  try {
    if (!fs.existsSync(triggerFile)) {
      fs.writeFileSync(triggerFile, '');
    }
  } catch (err) {
    console.error(`Failed to create trigger file: ${err}`);
    process.exit(1);
  }

  console.log('mococo dev — waiting for restart trigger');
  console.log(`Workspace: ${ws}`);
  console.log('Run "mococo restart" to rebuild and restart.');
  console.log('Press Ctrl+C to stop.\n');

  const execCmd = `npm run build --prefix "${projectRoot}" && node "${path.join(projectRoot, 'dist', 'cli', 'index.js')}" start`;
  const child = spawn(
    'npx',
    [
      'nodemon',
      '--watch', triggerFile,
      '--ext', 'hooks',
      '--exec', execCmd,
    ],
    {
      cwd: ws,
      stdio: 'inherit',
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
