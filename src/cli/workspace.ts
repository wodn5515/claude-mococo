import fs from 'node:fs';
import path from 'node:path';

/** Walk up from startDir looking for a directory containing teams.json */
export function findWorkspace(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'teams.json'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/** Require a workspace or exit with an error message */
export function requireWorkspace(startDir?: string): string {
  const ws = findWorkspace(startDir);
  if (!ws) {
    console.error('No mococo workspace found. Run `mococo init` first.');
    process.exit(1);
  }
  return ws;
}

/** Check that a workspace has the expected structure */
export function validateWorkspace(workspacePath: string): string[] {
  const issues: string[] = [];
  const check = (rel: string) => {
    if (!fs.existsSync(path.join(workspacePath, rel))) {
      issues.push(`Missing: ${rel}`);
    }
  };
  check('teams.json');
  check('.env');
  check('prompts');
  check('repos');
  check('hooks');
  return issues;
}
