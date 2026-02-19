import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { HookEvent } from '../types.js';

export const hookEvents = new EventEmitter();

const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit

function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
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
      resolve(aborted ? null : body);
    });
  });
}

function verifyGitHubSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function startHookServer(port: number) {
  const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || '';

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }

    // ---- Claude Code hook endpoint ----
    if (req.url === '/hook') {
      const body = await readBody(req, res);
      if (body === null) return; // aborted
      try {
        const event: HookEvent = JSON.parse(body);
        hookEvents.emit('any', event);
        hookEvents.emit(event.hook_event_name, event);
      } catch {
        // invalid JSON, ignore
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // ---- GitHub webhook endpoint ----
    if (req.url === '/github') {
      const body = await readBody(req, res);
      if (body === null) return; // aborted

      // Verify signature if secret is configured
      if (githubWebhookSecret) {
        const sig = req.headers['x-hub-signature-256'] as string | undefined;
        if (!verifyGitHubSignature(body, sig, githubWebhookSecret)) {
          console.warn('[hook-receiver] GitHub webhook signature mismatch');
          res.writeHead(401);
          res.end();
          return;
        }
      }

      const githubEvent = req.headers['x-github-event'] as string | undefined;
      if (!githubEvent) {
        res.writeHead(400);
        res.end();
        return;
      }

      try {
        const payload = JSON.parse(body);
        hookEvents.emit('github', { event: githubEvent, payload });
        console.log(`[hook-receiver] GitHub event: ${githubEvent} (action: ${payload.action ?? 'n/a'})`);
      } catch {
        // invalid JSON
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    console.log(`Hook receiver listening on :${port}`);
  });

  return server;
}
