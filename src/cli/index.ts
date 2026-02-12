#!/usr/bin/env node

const command = process.argv[2];
const arg = process.argv[3];

async function main(): Promise<void> {
  switch (command) {
    case 'init': {
      const { runInit } = await import('./commands/init.js');
      await runInit();
      break;
    }
    case 'add': {
      const { runAdd } = await import('./commands/add.js');
      await runAdd();
      break;
    }
    case 'start': {
      const { runStart } = await import('./commands/start.js');
      await runStart();
      break;
    }
    case 'dev': {
      const { runDev } = await import('./commands/dev.js');
      await runDev();
      break;
    }
    case 'restart': {
      const { runRestart } = await import('./commands/restart.js');
      await runRestart();
      break;
    }
    case 'list':
    case 'ls': {
      const { runList } = await import('./commands/list.js');
      await runList();
      break;
    }
    case 'edit': {
      const { runEdit } = await import('./commands/edit.js');
      await runEdit(arg ?? '');
      break;
    }
    case 'remove':
    case 'rm': {
      const { runRemove } = await import('./commands/remove.js');
      await runRemove(arg ?? '');
      break;
    }
    default:
      console.log(`mococo — AI assistants on Discord

Usage:
  mococo init              Create a new workspace
  mococo add               Add an assistant (interactive)
  mococo edit <id>         Edit an assistant's settings
  mococo start             Start all assistants
  mococo dev               Start in dev mode (rebuild on trigger)
  mococo restart           Trigger rebuild + restart (use with dev)
  mococo list              List configured assistants
  mococo remove <id>       Remove an assistant

Getting started:
  mkdir my-team && cd my-team
  mococo init
  mococo add
  mococo start`);
      if (command && command !== 'help' && command !== '--help' && command !== '-h') {
        console.error(`\nUnknown command: ${command}`);
        process.exit(1);
      }
      break;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
