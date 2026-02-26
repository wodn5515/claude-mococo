import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { HookEvent } from '../types.js';

export const hookEvents = new EventEmitter();

const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

let activeServer: http.Server | null = null;

export function stopHookServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
    console.log('[hook-receiver] Server stopped');
  }
}

export function startHookServer(port: number, secret?: string) {
  if (!secret) {
    console.warn('[hook-receiver] HOOK_SECRET not set — all requests will be rejected. Set HOOK_SECRET in .env');
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }

    if (!secret) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"HOOK_SECRET not configured"}');
      return;
    }

    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${secret}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }

    let body = '';
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        if (!aborted) {
          aborted = true;
          console.warn(`[hook-receiver] Request body exceeded ${MAX_BODY_SIZE} bytes, rejecting`);
          res.writeHead(413);
          res.end();
          req.destroy();
        }
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
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

  server.on('error', (err) => {
    console.error(`[hook-receiver] Server error:`, err);
  });

  server.listen(port, () => {
    console.log(`Hook receiver listening on :${port}`);
  });

  activeServer = server;
  return server;
}
