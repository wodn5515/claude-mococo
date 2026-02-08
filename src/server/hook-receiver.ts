import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { HookEvent } from '../types.js';

export const hookEvents = new EventEmitter();

export function startHookServer(port: number) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const event: HookEvent = JSON.parse(body);
        hookEvents.emit('any', event);
        hookEvents.emit(event.hook_event_name, event);
      } catch {
        // invalid JSON, ignore
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  server.listen(port, () => {
    console.log(`Hook receiver listening on :${port}`);
  });

  return server;
}
