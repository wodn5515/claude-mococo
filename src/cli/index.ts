#!/usr/bin/env node

import { loadEnvFile } from '../env.js';
import { runInit } from './commands/init.js';
import { runAdopt } from './commands/adopt.js';
import { runRelease } from './commands/release.js';
import { runList } from './commands/list.js';
import { runBot } from './commands/run.js';

// Auto-load ~/.mococo/.env before anything else
loadEnvFile();

const [,, command, ...args] = process.argv;

const COMMANDS: Record<string, () => Promise<void>> = {
  init: runInit,
  adopt: () => runAdopt(args[0]),
  run: () => runBot(args[0]),
  list: runList,
  release: () => runRelease(args[0]),
};

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    console.log(`
mococo — AI team adoption center

Usage:
  mococo init              Create ~/.mococo/ (first time setup)
  mococo adopt <id>        Adopt a new mococo bot
  mococo run <id>          Run a bot (one terminal per bot)
  mococo list              List all adopted bots
  mococo release <id>      Release (remove) a bot
`);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    console.error('Run "mococo --help" for available commands.');
    process.exit(1);
  }

  await handler();
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
