import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runRestart(): Promise<void> {
  const thisFile = fileURLToPath(import.meta.url);
  const projectRoot = path.resolve(path.dirname(thisFile), '..', '..', '..');
  const triggerFile = path.join(projectRoot, '.restart-trigger');

  // Update the trigger file timestamp (creates if missing)
  fs.writeFileSync(triggerFile, new Date().toISOString());

  console.log('Restart triggered — mococo dev will rebuild and restart.');
}
