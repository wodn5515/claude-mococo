import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
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

export function startHookServer(port: number) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Bearer token authentication (optional — only enforced when HOOK_SECRET is set)
    const hookSecret = process.env.HOOK_SECRET;
    if (hookSecret) {
      const auth = req.headers.authorization;
      const expected = Buffer.from(`Bearer ${hookSecret}`);
      const actual = Buffer.from(auth ?? '');
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        console.warn('[hook-receiver] Unauthorized request');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
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
        const parsed: unknown = JSON.parse(body);

        // Validate parsed data is a non-null object
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          console.warn('[hook-receiver] Invalid payload: expected a JSON object');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"payload must be a JSON object"}');
          return;
        }

        const obj = parsed as Record<string, unknown>;

        // Validate required fields exist and have correct types
        if (typeof obj.hook_event_name !== 'string' || obj.hook_event_name.length === 0) {
          console.warn('[hook-receiver] Invalid payload: missing or invalid hook_event_name');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"hook_event_name must be a non-empty string"}');
          return;
        }

        if (typeof obj.session_id !== 'string' || obj.session_id.length === 0) {
          console.warn('[hook-receiver] Invalid payload: missing or invalid session_id');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"session_id must be a non-empty string"}');
          return;
        }

        // Validate optional fields have correct types when present
        if (obj.mococo_team !== undefined && typeof obj.mococo_team !== 'string') {
          console.warn('[hook-receiver] Invalid payload: mococo_team must be a string');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"mococo_team must be a string"}');
          return;
        }

        if (obj.teammate_name !== undefined && typeof obj.teammate_name !== 'string') {
          console.warn('[hook-receiver] Invalid payload: teammate_name must be a string');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"teammate_name must be a string"}');
          return;
        }

        if (obj.task_subject !== undefined && typeof obj.task_subject !== 'string') {
          console.warn('[hook-receiver] Invalid payload: task_subject must be a string');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"task_subject must be a string"}');
          return;
        }

        if (obj.tool_name !== undefined && typeof obj.tool_name !== 'string') {
          console.warn('[hook-receiver] Invalid payload: tool_name must be a string');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"tool_name must be a string"}');
          return;
        }

        if (obj.tool_input !== undefined &&
            (typeof obj.tool_input !== 'object' || obj.tool_input === null || Array.isArray(obj.tool_input))) {
          console.warn('[hook-receiver] Invalid payload: tool_input must be an object');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"ok":false,"error":"tool_input must be an object"}');
          return;
        }

        const event = obj as HookEvent;
        hookEvents.emit('any', event);
        hookEvents.emit(event.hook_event_name, event);
      } catch {
        console.warn('[hook-receiver] Failed to parse JSON body');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('{"ok":false,"error":"invalid JSON"}');
        return;
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
