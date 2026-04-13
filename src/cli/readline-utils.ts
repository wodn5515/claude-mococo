import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

let rl: readline.Interface | null = null;

function getRL(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({ input: stdin, output: stdout });
  }
  return rl;
}

export function closeRL(): void {
  rl?.close();
  rl = null;
}

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : '';
  const answer = await getRL().question(`${question}${suffix}: `);
  return answer.trim() || defaultValue || '';
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await getRL().question(`${question} [${hint}]: `);
  const val = answer.trim().toLowerCase();
  if (!val) return defaultYes;
  return val === 'y' || val === 'yes';
}
