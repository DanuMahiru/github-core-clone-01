// The HTTP server: one process, one store, four surfaces. Routing is by path: /healthz (the
// env's boot probe, no auth), /api/v3/* (REST), /api/graphql, /mcp, and /{owner}/{repo}.git/*
// (git smart HTTP). Every other route is a JSON 404.
//
// Auth: every API call arrives with Authorization: Bearer $MAKEFUN_SHOP_TOKEN, the same token
// this process carries in its environment. A request without it (or with a wrong one) is 401.
// When the environment carries no token at all, the entry accepts unauthenticated calls, the
// way the suite's clients behave when they have no token to send.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './src/store.ts';
import { scenarioViewer, VIEWER_LOGIN } from './src/scenario.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphql } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/gitproto.ts';
import { jsonResponse, type HttpRequest, type HttpResponse } from './src/http.ts';

/** The largest request body the server reads (packs are far below this). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The token owner, derived from the contest's fixed scenario seed. */
function viewer() {
  try {
    return scenarioViewer();
  } catch {
    return { id: 1000, login: VIEWER_LOGIN, name: 'ada iversen', email: 'adaiversen@example.invalid' };
  }
}

function send(res: ServerResponse, response: HttpResponse): void {
  const headers: Record<string, string> = {
    'content-type': response.contentType,
    'content-length': String(response.body.length),
    'x-github-request-id': randomUUID(),
    ...(response.headers ?? {}),
  };
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function headersOf(req: IncomingMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') map.set(name.toLowerCase(), value);
    else if (Array.isArray(value) && value.length > 0) map.set(name.toLowerCase(), value[0] as string);
  }
  return map;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request carries the trial's bearer token (or no token is configured). */
function authenticated(headers: Map<string, string>): boolean {
  if (EXPECTED_TOKEN === '') return true;
  const header = headers.get('authorization');
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge(viewer());
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        const headers = headersOf(req);
        const url = new URL(req.url ?? '/', 'http://entry');

        // The env's boot check calls this twice: 200 {"ok":true}. It takes no token.
        if (method === 'GET' && path === '/healthz') {
          send(res, jsonResponse(200, { ok: true }));
          return;
        }

        const body = await readBody(req);
        const httpRequest: HttpRequest = {
          method,
          url,
          headers,
          body,
          host: headers.get('host') ?? '127.0.0.1',
        };

        if (!authenticated(headers)) {
          send(res, jsonResponse(401, { message: 'Requires authentication' }));
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const response = handleRest(forge, httpRequest);
          if (response !== null) {
            send(res, response);
            return;
          }
        }

        // GraphQL v4.
        if (path === '/api/graphql' && method === 'POST') {
          send(res, handleGraphql(forge, httpRequest));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          const response = handleMcp(forge, httpRequest);
          if (response !== null) {
            send(res, response);
            return;
          }
        }

        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const service = gitMatch[3] as string;
          if (service === 'info/refs' && method === 'GET') {
            send(res, handleInfoRefs(forge, owner, repoName, httpRequest));
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            send(res, handleUploadPack(forge, owner, repoName, httpRequest));
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            send(res, handleReceivePack(forge, owner, repoName, httpRequest));
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body.
        send(res, jsonResponse(404, { message: 'Not Found' }));
      } catch (err) {
        // A request must never take the server down: answer 500 and stay up.
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) {
          send(res, jsonResponse(500, { message: 'Internal Server Error' }));
        } else {
          res.end();
        }
      }
    })();
  });
}
