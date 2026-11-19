// The MCP endpoint at POST /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28
// (server/discover, no session), with the 2025-11-25-and-earlier handshake (initialize) as a
// fallback. Six tools act on the same store as REST, so a repository or issue created over MCP
// reads back over /api/v3 as the same object.

import { isRecord, jsonResponse, type HttpRequest, type HttpResponse } from './http.ts';
import { type Forge } from './store.ts';

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tools, in a fixed order: two tools/list calls answer this list byte for byte. */
const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login; defaults to the authenticated user.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by squash.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): HttpResponse {
  return jsonResponse(200, { jsonrpc: '2.0', id, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): HttpResponse {
  return jsonResponse(status, { jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run one tool. Returns a tool result, or an isError result when the call cannot run. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((item) => item.name === name);
  if (tool === undefined) return toolError(`unknown tool ${name}`);
  const schema = tool.inputSchema as { required?: string[] };
  const required = schema.required ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return toolError(`missing required argument: ${key}`);
    }
  }
  const str = (key: string): string => (typeof args[key] === 'string' ? (args[key] as string) : '');
  const repoOf = (): { repo: ReturnType<Forge['getRepo']> } | { error: string } => {
    const repo = forge.getRepo(str('owner'), str('repo'));
    if (repo === undefined) return { error: `repository ${str('owner')}/${str('repo')} does not exist` };
    return { repo };
  };

  if (name === 'create_repo') {
    const repoName = str('name');
    if (forge.getRepo(forge.viewer.login, repoName) !== undefined) {
      return toolError(`repository ${forge.viewer.login}/${repoName} already exists`);
    }
    const repo = forge.createRepo(
      forge.viewer.login,
      repoName,
      typeof args.description === 'string' ? (args.description as string) : '',
      args.private === true,
    );
    return toolResult(forge.repoJson(repo));
  }
  if (name === 'get_repo') {
    const found = repoOf();
    if ('error' in found) return toolError(found.error);
    return toolResult(forge.repoJson(found.repo as NonNullable<ReturnType<Forge['getRepo']>>));
  }
  if (name === 'create_issue') {
    const found = repoOf();
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Forge['getRepo']>>;
    const created = forge.createIssue(repo, str('title'), str('body'), []);
    if ('error' in created) return toolError(created.error);
    return toolResult(forge.issueJson(repo, created));
  }
  if (name === 'list_issues') {
    const found = repoOf();
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Forge['getRepo']>>;
    const state = str('state') === 'closed' ? 'closed' : str('state') === 'all' ? 'all' : 'open';
    const issues = forge.listIssues(repo, state).map((issue) => forge.issueJson(repo, issue));
    return toolResult(issues);
  }
  if (name === 'create_pull_request') {
    const found = repoOf();
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Forge['getRepo']>>;
    const created = forge.createPull(repo, str('title'), str('body'), str('head'), str('base'));
    if ('error' in created) return toolError(created.error);
    return toolResult(forge.pullJson(repo, created));
  }
  if (name === 'merge_pull_request') {
    const found = repoOf();
    if ('error' in found) return toolError(found.error);
    const repo = found.repo as NonNullable<ReturnType<Forge['getRepo']>>;
    const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
    const pull = forge.getPull(repo, number);
    if (pull === undefined) return toolError(`pull request ${number} does not exist`);
    if (pull.state !== 'open') return toolError(`pull request ${number} is not open`);
    const mergeSha = forge.mergePull(repo, pull);
    if (mergeSha === null) return toolError(`pull request ${number} conflicts with its base branch`);
    return toolResult({
      merged: true,
      sha: mergeSha,
      message: `Merge pull request #${pull.number} from ${pull.headRef}`,
      number: pull.number,
      state: 'closed',
    });
  }
  return toolError(`unknown tool ${name}`);
}

/** POST /mcp (and DELETE for a legacy session goodbye). */
export function handleMcp(forge: Forge, req: HttpRequest): HttpResponse | null {
  if (req.url.pathname !== '/mcp') return null;
  if (req.method === 'DELETE') {
    return jsonResponse(200, {});
  }
  if (req.method !== 'POST') {
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
    return jsonResponse(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }, { 'content-type': 'application/json; charset=utf-8' });
  }
  if (Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request: batching is not supported');
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const id = body.id;
  const isNotification = id === undefined;
  const method = body.method;
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_REVISIONS,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    if (isNotification) return jsonResponse(202, {});
    return rpcResult(id, result);
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PREFERRED_REVISION;
    const negotiated = SUPPORTED_REVISIONS.includes(requested) ? requested : PREFERRED_REVISION;
    const result = {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
    if (isNotification) return jsonResponse(202, {});
    return rpcResult(id, result);
  }
  if (method === 'notifications/initialized') {
    return jsonResponse(202, {});
  }
  if (method === 'tools/list') {
    if (isNotification) return jsonResponse(202, {});
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (isNotification) return jsonResponse(202, {});
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    // A tool the server does not offer answers -32602, never HTTP 500.
    if (!TOOLS.some((tool) => tool.name === toolName)) {
      return rpcError(id, -32602, `unknown tool ${toolName}`);
    }
    const result = callTool(forge, toolName, args);
    return rpcResult(id, result);
  }
  if (isNotification) return jsonResponse(202, {});
  return rpcError(id, -32601, `method not found: ${method}`);
}
