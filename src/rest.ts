// The REST v3 surface under /api/v3: repositories, branches, commits, contents, labels,
// issues, comments, pull requests, files and merges. Every reply is application/json and
// carries a non-empty X-GitHub-Request-Id; an error carries {"message": string}.

import { randomUUID } from 'node:crypto';
import {
  emptyResponse,
  isRecord,
  jsonResponse,
  parseJsonBody,
  type HttpRequest,
  type HttpResponse,
} from './http.ts';
import { type Forge, type Issue, type PullRequest, type Repo } from './store.ts';

const notFound = (message: string): HttpResponse => jsonResponse(404, { message });
const badRequest = (message: string): HttpResponse => jsonResponse(400, { message });
const unprocessable = (message: string): HttpResponse => jsonResponse(422, { message });
const conflict = (message: string): HttpResponse => jsonResponse(409, { message });

/** The request id every REST reply carries. */
function requestId(): string {
  return randomUUID();
}

/** Wrap a JSON reply with the protocol headers (request id, scopes). */
function reply(status: number, body: unknown, extra: Record<string, string> = {}): HttpResponse {
  return jsonResponse(status, body, {
    'x-github-request-id': requestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...extra,
  });
}

/** A page of a list, with GitHub's Link header when another page follows. */
function paginate<T>(req: HttpRequest, items: T[], toJson: (item: T) => unknown): HttpResponse {
  const query = req.url.searchParams;
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) {
    const base = `http://${req.host}${req.url.pathname}`;
    const link = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
    const parts = [link(page + 1, 'next'), link(totalPages, 'last')];
    if (page > 1) parts.push(link(page - 1, 'prev'), link(1, 'first'));
    headers.link = parts.join(', ');
  }
  return reply(200, slice.map(toJson), headers);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The repo a route names, or the 404 to answer when it is not there. */
function lookupRepo(forge: Forge, owner: string, name: string): { repo: Repo } | { response: HttpResponse } {
  const repo = forge.getRepo(owner, name);
  if (repo === undefined) return { response: notFound(`repository ${owner}/${name} does not exist`) };
  return { repo };
}

function queryInt(req: HttpRequest, name: string, fallback: number): number {
  const raw = req.url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : fallback;
}

/** Route a REST request. Returns null when the path is not under /api/v3. */
export function handleRest(forge: Forge, req: HttpRequest): HttpResponse | null {
  const path = req.url.pathname;
  if (path !== '/api/v3' && !path.startsWith('/api/v3/')) return null;
  const method = req.method;
  const segments = path.split('/').filter((segment) => segment !== '');

  // GET /api/v3/ — the API root.
  if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
    return reply(200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    });
  }
  // GET /api/v3/meta — the installed version.
  if (path === '/api/v3/meta' && method === 'GET') {
    return reply(200, { installed_version: '1.0.0' });
  }

  // A JSON body, when one is carried; malformed JSON is a 400 everywhere.
  let bodyJson: unknown;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseJsonBody(req.body);
    if (parsed.malformed) return badRequest('request body is not valid JSON');
    bodyJson = parsed.value;
  }

  // GET /api/v3/user — the token owner.
  if (path === '/api/v3/user' && method === 'GET') {
    return reply(200, forge.userJson(forge.viewer.login));
  }

  // /api/v3/user/repos — list (GET) and create (POST).
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const repos = forge.listReposByOwner(forge.viewer.login);
      return paginate(req, repos, (repo) => forge.repoJson(repo));
    }
    if (method === 'POST') {
      if (!isRecord(bodyJson)) return unprocessable('a repository needs a name');
      const name = bodyJson.name;
      if (typeof name !== 'string' || name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
        return unprocessable('a repository needs a valid name');
      }
      if (forge.getRepo(forge.viewer.login, name) !== undefined) {
        return unprocessable(`repository ${forge.viewer.login}/${name} already exists`);
      }
      const description = typeof bodyJson.description === 'string' ? bodyJson.description : '';
      const isPrivate = bodyJson.private === true;
      const repo = forge.createRepo(forge.viewer.login, name, description, isPrivate);
      return reply(201, forge.repoJson(repo));
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  // /api/v3/repos/{owner}/{repo}/... — everything else.
  if (segments.length >= 4 && segments[0] === 'api' && segments[1] === 'v3' && segments[2] === 'repos') {
    const owner = decodeSegment(segments[3] as string);
    const repoName = decodeSegment(segments[4] as string);
    const rest = segments.slice(5);
    return handleRepoRoute(forge, req, owner, repoName, rest, bodyJson);
  }

  return notFound('Not Found');
}

function handleRepoRoute(
  forge: Forge,
  req: HttpRequest,
  owner: string,
  repoName: string,
  rest: string[],
  bodyJson: unknown,
): HttpResponse {
  const method = req.method;
  const found = lookupRepo(forge, owner, repoName);
  if ('response' in found) return found.response;
  const repo = found.repo;

  // /repos/{owner}/{repo} — read, patch, delete.
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, forge.repoJson(repo));
    if (method === 'PATCH') {
      if (isRecord(bodyJson)) {
        if (typeof bodyJson.description === 'string') repo.description = bodyJson.description;
        if (typeof bodyJson.private === 'boolean') repo.private = bodyJson.private;
      }
      return reply(200, forge.repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return emptyResponse(204, { 'x-github-request-id': requestId() });
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  const [section, ...tail] = rest as [string, ...string[]];

  // Branches.
  if (section === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = forge.branchNames(repo).map((name) => forge.branchJson(repo, name));
      return reply(200, branches);
    }
    if (tail.length === 1 && method === 'GET') {
      const branch = forge.branchJson(repo, decodeSegment(tail[0] as string));
      if (branch === null) return notFound(`branch ${tail[0]} does not exist`);
      return reply(200, branch);
    }
    return notFound('Not Found');
  }

  // Commits.
  if (section === 'commits' && tail.length === 0 && method === 'GET') {
    const ref = req.url.searchParams.get('sha') ?? repo.defaultBranch;
    const commits = forge.listCommits(repo, ref);
    const perPage = queryInt(req, 'per_page', 30);
    const page = queryInt(req, 'page', 1);
    const start = (page - 1) * perPage;
    const slice = commits.slice(start, start + perPage);
    return reply(
      200,
      slice.map((commit) => forge.commitJson(repo, commit.sha)).filter((item) => item !== null),
    );
  }

  // Contents.
  if (section === 'contents') {
    const contentPath = tail.map(decodeSegment).join('/');
    const ref = req.url.searchParams.get('ref') ?? null;
    if (method === 'GET') {
      const read = forge.readContents(repo, contentPath, ref);
      if (read === null) return notFound(`path ${contentPath} does not exist`);
      if (read.kind === 'dir') {
        return reply(
          200,
          read.entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: contentPath === '' ? entry.name : `${contentPath}/${entry.name}`,
            sha: entry.sha,
            size: entry.type === 'file' ? forge.blobLineCount(repo, entry.sha) : 0,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath === '' ? entry.name : `${contentPath}/${entry.name}`}`,
          })),
        );
      }
      return reply(200, {
        type: 'file',
        encoding: 'base64',
        content: read.data.toString('base64'),
        sha: read.entry.sha,
        size: read.data.length,
        name: read.entry.name,
        path: contentPath,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
      });
    }
    if (method === 'PUT') {
      if (!isRecord(bodyJson)) return unprocessable('a contents write needs a message and content');
      const content = bodyJson.content;
      if (typeof content !== 'string') return unprocessable('a contents write needs base64 content');
      let data: Buffer;
      try {
        data = Buffer.from(content, 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const message = typeof bodyJson.message === 'string' ? bodyJson.message : `Update ${contentPath}`;
      const branch = typeof bodyJson.branch === 'string' ? bodyJson.branch : null;
      const sha = typeof bodyJson.sha === 'string' ? bodyJson.sha : null;
      const current = forge.readContents(repo, contentPath, branch);
      const isUpdate = current !== null && current.kind === 'file';
      if (sha !== null) {
        if (!isUpdate || current.entry.sha !== sha) {
          return conflict('the sha does not match the file on the branch');
        }
      } else if (isUpdate) {
        return unprocessable('updating a file needs its current sha');
      }
      const { blobSha, commitSha } = forge.writeContents(repo, contentPath, data, message, branch);
      return reply(isUpdate ? 200 : 201, {
        content: {
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: blobSha,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          url: `/api/v3/repos/${owner}/${repoName}/contents/${contentPath}`,
        },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const sha = isRecord(bodyJson) && typeof bodyJson.sha === 'string' ? bodyJson.sha : null;
      const current = forge.readContents(repo, contentPath, null);
      if (current === null || current.kind !== 'file') return notFound(`path ${contentPath} does not exist`);
      if (sha !== null && current.entry.sha !== sha) {
        return conflict('the sha does not match the file on the branch');
      }
      const message = isRecord(bodyJson) && typeof bodyJson.message === 'string' ? bodyJson.message : `Delete ${contentPath}`;
      const commitSha = forge.deleteContents(repo, contentPath, message, null);
      if (commitSha === null) return notFound(`path ${contentPath} does not exist`);
      return reply(200, { commit: { sha: commitSha, message } });
    }
    return jsonResponse(405, { message: 'Method Not Allowed' });
  }

  // Labels.
  if (section === 'labels' && tail.length === 0 && method === 'POST') {
    if (!isRecord(bodyJson) || typeof bodyJson.name !== 'string' || bodyJson.name === '') {
      return unprocessable('a label needs a name');
    }
    const color = typeof bodyJson.color === 'string' ? bodyJson.color : 'ededed';
    const label = { name: bodyJson.name, color };
    repo.labels.set(label.name, label);
    return reply(201, forge.labelJson(label));
  }

  // Issues.
  if (section === 'issues') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = (req.url.searchParams.get('state') ?? 'open') as 'open' | 'closed' | 'all';
        const direction = req.url.searchParams.get('direction') ?? 'desc';
        const issues = forge.listIssues(repo, state === 'all' ? 'all' : state);
        const sorted = issues.slice().sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        return paginate(req, sorted, (issue) => forge.issueJson(repo, issue));
      }
      if (method === 'POST') {
        if (!isRecord(bodyJson) || typeof bodyJson.title !== 'string' || bodyJson.title === '') {
          return unprocessable('an issue needs a title');
        }
        const body = typeof bodyJson.body === 'string' ? bodyJson.body : '';
        const labels = Array.isArray(bodyJson.labels)
          ? bodyJson.labels.filter((label): label is string => typeof label === 'string')
          : [];
        const created = forge.createIssue(repo, bodyJson.title, body, labels);
        if ('error' in created) return unprocessable(created.error);
        return reply(201, forge.issueJson(repo, created));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }
    const number = Number.parseInt(tail[0] as string, 10);
    if (!Number.isSafeInteger(number)) return notFound('Not Found');
    if (tail.length === 1) {
      if (method === 'GET') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound(`issue ${number} does not exist`);
        return reply(200, forge.issueJson(repo, issue));
      }
      if (method === 'PATCH') {
        const issue = forge.getIssue(repo, number);
        if (issue === undefined) return notFound(`issue ${number} does not exist`);
        if (isRecord(bodyJson)) {
          if (bodyJson.state === 'open' || bodyJson.state === 'closed') {
            forge.setIssueState(repo, number, bodyJson.state);
          }
          if (typeof bodyJson.title === 'string') issue.title = bodyJson.title;
          if (typeof bodyJson.body === 'string') issue.body = bodyJson.body;
        }
        const updated = forge.getIssue(repo, number) as Issue;
        return reply(200, forge.issueJson(repo, updated));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (method === 'GET') {
        const comments = forge.listComments(repo, number);
        return paginate(req, comments, (comment) => forge.commentJson(repo, number, comment));
      }
      if (method === 'POST') {
        if (!isRecord(bodyJson) || typeof bodyJson.body !== 'string' || bodyJson.body === '') {
          return unprocessable('a comment needs a body');
        }
        const comment = forge.addComment(repo, number, bodyJson.body);
        if (comment === undefined) return notFound(`issue ${number} does not exist`);
        return reply(201, forge.commentJson(repo, number, comment));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }
    return notFound('Not Found');
  }

  // Pull requests.
  if (section === 'pulls') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = (req.url.searchParams.get('state') ?? 'open') as 'open' | 'closed' | 'all';
        const pulls = forge.listPulls(repo, state === 'all' ? 'all' : state);
        return paginate(req, pulls, (pull) => forge.pullJson(repo, pull));
      }
      if (method === 'POST') {
        if (!isRecord(bodyJson) || typeof bodyJson.title !== 'string' || bodyJson.title === '') {
          return unprocessable('a pull request needs a title');
        }
        const head = typeof bodyJson.head === 'string' ? bodyJson.head : '';
        const base = typeof bodyJson.base === 'string' ? bodyJson.base : repo.defaultBranch;
        const body = typeof bodyJson.body === 'string' ? bodyJson.body : '';
        const created = forge.createPull(repo, bodyJson.title, body, head, base);
        if ('error' in created) return unprocessable(created.error);
        return reply(201, forge.pullJson(repo, created));
      }
      return jsonResponse(405, { message: 'Method Not Allowed' });
    }
    const number = Number.parseInt(tail[0] as string, 10);
    if (!Number.isSafeInteger(number)) return notFound('Not Found');
    if (tail.length === 1 && method === 'GET') {
      const pull = forge.getPull(repo, number);
      if (pull === undefined) return notFound(`pull request ${number} does not exist`);
      return reply(200, forge.pullJson(repo, pull));
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      const pull = forge.getPull(repo, number);
      if (pull === undefined) return notFound(`pull request ${number} does not exist`);
      const files = forge.pullFiles(repo, pull).map((change) => ({
        filename: change.filename,
        status: change.status === 'removed' ? 'modified' : change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
      }));
      return reply(200, files);
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      const pull = forge.getPull(repo, number);
      if (pull === undefined) return notFound(`pull request ${number} does not exist`);
      if (pull.state !== 'open') return jsonResponse(405, { message: 'pull request is not open' });
      const mergeSha = forge.mergePull(repo, pull);
      if (mergeSha === null) {
        return jsonResponse(405, { message: 'pull request cannot be merged: it conflicts with the base branch' });
      }
      const updated = forge.getPull(repo, number) as PullRequest;
      return reply(200, {
        merged: true,
        sha: mergeSha,
        message: `Merge pull request #${updated.number} from ${updated.headRef}`,
      });
    }
    return notFound('Not Found');
  }

  // Git refs.
  if (section === 'git' && tail.length >= 1 && tail[0] === 'refs') {
    if (tail.length === 1 && method === 'POST') {
      if (!isRecord(bodyJson) || typeof bodyJson.ref !== 'string' || typeof bodyJson.sha !== 'string') {
        return unprocessable('creating a ref needs a ref and a sha');
      }
      const ref = bodyJson.ref;
      const sha = bodyJson.sha;
      if (!ref.startsWith('refs/')) return unprocessable('a ref must start with refs/');
      if (repo.refs.has(ref)) return unprocessable(`ref ${ref} already exists`);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') {
        return unprocessable(`object ${sha} is not a commit this forge holds`);
      }
      repo.refs.set(ref, sha);
      return reply(201, {
        ref,
        node_id: `ref-${ref}`,
        object: { sha, type: 'commit' },
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
      });
    }
    if (tail.length >= 3 && tail[1] === 'heads' && method === 'GET') {
      const branch = tail.slice(2).map(decodeSegment).join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === null) return notFound(`branch ${branch} does not exist`);
      return reply(200, {
        ref: `refs/heads/${branch}`,
        node_id: `ref-refs/heads/${branch}`,
        object: { sha: tip, type: 'commit' },
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/heads/${branch}`,
      });
    }
    return notFound('Not Found');
  }

  return notFound('Not Found');
}
