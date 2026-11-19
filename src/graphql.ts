// The GraphQL v4 surface at POST /api/graphql: a small parser and executor for the documents
// gh and github-mcp-server actually send (viewer, repository fields, introspection, issue and
// pull-request reads, the five mutations, node(id:) and cursor pagination), plus batching: two
// operation documents in one body answer two results in order. An unknown field is HTTP 200
// with an errors array naming it; an unknown repository is data.repository = null, no errors.

import { decodeGlobalId, globalId, type Forge, type Issue, type PullRequest, type Repo } from './store.ts';
import { isRecord, type HttpRequest, type HttpResponse, jsonResponse } from './http.ts';

// -------------------------------------------------------------------------------------------------
// Tokenizer and parser (the GraphQL document grammar, as far as the suite's documents use it)
// -------------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'string'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value: Number.parseInt(value, 10) });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[];
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: GqlSelection[] };

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; type: string; required: boolean }>;
  selections: GqlSelection[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected "${value}" in GraphQL document, got ${JSON.stringify(token)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token)}`);
    return token.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first !== undefined && first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    const variables: GqlOperation['variables'] = [];
    const maybeParen = this.peek();
    if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (true) {
        const token = this.peek();
        if (token !== undefined && token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        let varType = '';
        let required = false;
        while (true) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '!') {
            required = true;
            break;
          }
          if (token.kind === 'punct' && token.value === '[') varType += '[';
          else if (token.kind === 'punct' && token.value === ']') varType += ']';
          else if (token.kind === 'name') varType += token.value;
          else throw new Error(`unexpected token in variable type: ${JSON.stringify(token)}`);
          const next = this.peek();
          if (next !== undefined && next.kind === 'punct' && next.value === '!') {
            this.next();
            required = true;
          }
          break;
        }
        variables.push({ name: varName, type: varType, required });
      }
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): GqlSelection {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | null = null;
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'inlineFragment', typeCondition, selections };
    }
    let alias: string | null = null;
    let name = this.expectName();
    const maybeColon = this.peek();
    if (maybeColon !== undefined && maybeColon.kind === 'punct' && maybeColon.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: GqlField['args'] = [];
    const maybeParen = this.peek();
    if (maybeParen !== undefined && maybeParen.kind === 'punct' && maybeParen.value === '(') {
      this.next();
      while (true) {
        const token = this.peek();
        if (token !== undefined && token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: GqlSelection[] = [];
    const maybeBrace = this.peek();
    if (maybeBrace !== undefined && maybeBrace.kind === 'punct' && maybeBrace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: GqlValue[] = [];
      while (true) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (true) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// -------------------------------------------------------------------------------------------------
// Values: every resolved node carries its GraphQL type so fields and fragments resolve on it.
// -------------------------------------------------------------------------------------------------

interface GqlNode {
  __type: string;
  [key: string]: unknown;
}

function node(type: string, fields: Record<string, unknown>): GqlNode {
  return { __type: type, ...fields };
}

/** The fields each type holds (for validation and for __type introspection). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
    'description', 'isPrivate',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'closedAt', 'labels', 'author', 'url', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
    'body', 'headRef', 'baseRef', 'createdAt', 'closedAt', 'author', 'url',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Branch: ['name'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  IssueEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
};

const INTROSPECTION: Record<string, { fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'closedAt', 'labels', 'author', 'url', 'comments'],
  },
  PullRequest: {
    fields: [
      'id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files',
      'body', 'headRef', 'baseRef', 'createdAt', 'closedAt', 'author', 'url',
    ],
  },
  Repository: {
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
      'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt',
      'description', 'isPrivate',
    ],
  },
  SearchType: { enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'] },
};

// -------------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------------

interface Executor {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((item) => item.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

function encodeCursor(afterNumber: number): string {
  return Buffer.from(`cursor:${afterNumber}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueNode(forge: Forge, repo: Repo, issue: Issue): GqlNode {
  return node('Issue', { repo, issue });
}

function pullNode(forge: Forge, repo: Repo, pull: PullRequest): GqlNode {
  return node('PullRequest', { repo, pull });
}

function repoNode(forge: Forge, repo: Repo): GqlNode {
  return node('Repository', { repo });
}

function prState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field on a node. Returns the raw value (a scalar, null, or another GqlNode). */
function resolveField(exec: Executor, typeName: string, source: GqlNode, field: GqlField): unknown {
  const forge = exec.forge;
  const variables = exec.variables;
  const args = (name: string): unknown => argValue(field, name, variables);

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      return node('User', { login: forge.viewer.login, id: forge.viewer.id });
    }
    if (field.name === 'repository') {
      const owner = args('owner');
      const name = args('name');
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = forge.getRepo(owner, name);
      return repo === undefined ? null : repoNode(forge, repo);
    }
    if (field.name === 'node') {
      const id = args('id');
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
        return repo === undefined ? null : repoNode(forge, repo);
      }
      if (decoded.kind === 'Issue') {
        const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
        const issue = repo === undefined ? undefined : forge.getIssue(repo, Number.parseInt(decoded.parts[1] as string, 10));
        return issue === undefined || repo === undefined ? null : issueNode(forge, repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
        const pull = repo === undefined ? undefined : forge.getPull(repo, Number.parseInt(decoded.parts[1] as string, 10));
        return pull === undefined || repo === undefined ? null : pullNode(forge, repo, pull);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args('name');
      if (typeof name !== 'string') return null;
      const info = INTROSPECTION[name];
      if (info === undefined) return null;
      return node('__Type', { name, fields: info.fields ?? null, enumValues: info.enumValues ?? null });
    }
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = args('input');
      if (!isRecord(input)) return null;
      const repo = typeof input.repositoryId === 'string' ? decodeRepoId(forge, input.repositoryId) : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'createIssue: the repository id names no repository' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const created = forge.createIssue(repo, title, body, []);
      if ('error' in created) {
        exec.errors.push({ message: `createIssue: ${created.error}` });
        return null;
      }
      return node('CreateIssuePayload', { issue: issueNode(forge, repo, created) });
    }
    if (field.name === 'closeIssue') {
      const input = args('input');
      if (!isRecord(input) || typeof input.issueId !== 'string') return null;
      const decoded = decodeGlobalId(input.issueId);
      if (decoded === null || decoded.kind !== 'Issue') return null;
      const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
      const issue = repo === undefined ? undefined : forge.getIssue(repo, Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === undefined || issue === undefined) return null;
      forge.setIssueState(repo, issue.number, 'closed');
      return node('CloseIssuePayload', { issue: issueNode(forge, repo, issue) });
    }
    if (field.name === 'createPullRequest') {
      const input = args('input');
      if (!isRecord(input)) return null;
      const repo = typeof input.repositoryId === 'string' ? decodeRepoId(forge, input.repositoryId) : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'createPullRequest: the repository id names no repository' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
      const created = forge.createPull(repo, title, '', head, base);
      if ('error' in created) {
        exec.errors.push({ message: `createPullRequest: ${created.error}` });
        return null;
      }
      return node('CreatePullRequestPayload', { pullRequest: pullNode(forge, repo, created) });
    }
    if (field.name === 'mergePullRequest') {
      const input = args('input');
      if (!isRecord(input) || typeof input.pullRequestId !== 'string') return null;
      const decoded = decodeGlobalId(input.pullRequestId);
      if (decoded === null || decoded.kind !== 'PullRequest') return null;
      const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
      const pull = repo === undefined ? undefined : forge.getPull(repo, Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === undefined || pull === undefined) return null;
      const merged = forge.mergePull(repo, pull);
      if (merged === null) {
        exec.errors.push({ message: 'mergePullRequest: the pull request conflicts with its base branch' });
        return null;
      }
      return node('MergePullRequestPayload', { pullRequest: pullNode(forge, repo, pull) });
    }
    if (field.name === 'addComment') {
      const input = args('input');
      if (!isRecord(input) || typeof input.subjectId !== 'string') return null;
      const decoded = decodeGlobalId(input.subjectId);
      if (decoded === null || decoded.kind !== 'Issue') return null;
      const repo = forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
      const issue = repo === undefined ? undefined : forge.getIssue(repo, Number.parseInt(decoded.parts[1] as string, 10));
      if (repo === undefined || issue === undefined) return null;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = forge.addComment(repo, issue.number, body);
      if (comment === undefined) return null;
      return node('AddCommentPayload', {
        commentEdge: node('IssueCommentEdge', {
          node: node('IssueComment', { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body }),
        }),
      });
    }
  }

  if (typeName === 'User') {
    if (field.name === 'login') return source.login as string;
    if (field.name === 'id') return globalId('User', source.id as number);
    if (field.name === 'name') return forge.viewer.name;
    if (field.name === 'email') return forge.viewer.email;
  }

  if (typeName === 'Repository') {
    const repo = source.repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return node('User', { login: repo.owner, id: forge.viewer.id });
      case 'defaultBranchRef':
        return node('Branch', { name: repo.defaultBranch });
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'issue': {
        const number = args('number');
        if (typeof number !== 'number') return null;
        const issue = forge.getIssue(repo, number);
        return issue === undefined ? null : issueNode(forge, repo, issue);
      }
      case 'issues': {
        const first = typeof args('first') === 'number' ? (args('first') as number) : 100;
        const states = args('states');
        const orderBy = args('orderBy');
        const after = args('after');
        let issues = repo.issues.slice();
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toLowerCase()));
          issues = issues.filter((issue) => wanted.has(issue.state));
        }
        let direction = 1;
        if (isRecord(orderBy)) {
          direction = orderBy.direction === 'ASC' ? 1 : -1;
          issues.sort((a, b) => (a.number - b.number) * direction);
        }
        // The cursor names the last node of the previous page: the next page continues
        // past it in the direction the list is sorted (below it when descending).
        const afterNumber = decodeCursor(typeof after === 'string' ? after : null);
        if (afterNumber !== null) {
          issues = issues.filter((issue) =>
            direction === 1 ? issue.number > afterNumber : issue.number < afterNumber,
          );
        }
        const page = issues.slice(0, first);
        const hasNextPage = issues.length > first;
        const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number ?? 0) : null;
        return node('IssueConnection', { repo, issues: page, hasNextPage, endCursor, totalCount: repo.issues.length });
      }
      case 'pullRequests': {
        const first = typeof args('first') === 'number' ? (args('first') as number) : 100;
        const pulls = repo.pulls.slice(0, first);
        return node('PullRequestConnection', { repo, pulls, hasNextPage: repo.pulls.length > first, endCursor: null, totalCount: repo.pulls.length });
      }
      case 'pullRequest': {
        const number = args('number');
        if (typeof number !== 'number') return null;
        const pull = forge.getPull(repo, number);
        return pull === undefined ? null : pullNode(forge, repo, pull);
      }
    }
  }

  if (typeName === 'Issue') {
    const repo = source.repo as Repo;
    const issue = source.issue as Issue;
    switch (field.name) {
      case 'id':
        return globalId('Issue', repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue);
      case 'body':
        return issue.body;
      case 'createdAt':
        return issue.createdAt;
      case 'closedAt':
        return issue.closedAt;
      case 'labels':
        return issue.labels.map((label) => label.name);
      case 'author':
        return node('User', { login: issue.userLogin, id: forge.viewer.id });
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'comments':
        return (forge.listComments(repo, issue.number) ?? []).map((comment) =>
          node('IssueComment', { id: globalId('IssueComment', repo.id, issue.number, comment.id), body: comment.body }),
        );
    }
  }

  if (typeName === 'PullRequest') {
    const repo = source.repo as Repo;
    const pull = source.pull as PullRequest;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'state':
        return prState(pull);
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      case 'body':
        return pull.body;
      case 'createdAt':
        return pull.createdAt;
      case 'closedAt':
        return pull.closedAt;
      case 'author':
        return node('User', { login: pull.userLogin, id: forge.viewer.id });
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const first = typeof args('first') === 'number' ? (args('first') as number) : 100;
        const files = forge.pullFiles(repo, pull).slice(0, first);
        return node('PullRequestChangedFileConnection', { files, hasNextPage: false, endCursor: null, totalCount: files.length });
      }
    }
  }

  if (typeName === 'IssueConnection') {
    if (field.name === 'nodes') return (source.issues as Issue[]).map((issue) => issueNode(forge, source.repo as Repo, issue));
    if (field.name === 'pageInfo') {
      return node('PageInfo', { hasNextPage: source.hasNextPage as boolean, endCursor: source.endCursor as string | null });
    }
    if (field.name === 'totalCount') return source.totalCount as number;
    if (field.name === 'edges') {
      return (source.issues as Issue[]).map((issue) =>
        node('IssueEdge', { node: issueNode(forge, source.repo as Repo, issue), cursor: encodeCursor(issue.number) }),
      );
    }
  }

  if (typeName === 'PullRequestConnection') {
    if (field.name === 'nodes') return (source.pulls as PullRequest[]).map((pull) => pullNode(forge, source.repo as Repo, pull));
    if (field.name === 'pageInfo') {
      return node('PageInfo', { hasNextPage: source.hasNextPage as boolean, endCursor: source.endCursor as string | null });
    }
    if (field.name === 'totalCount') return source.totalCount as number;
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    if (field.name === 'nodes') {
      return (source.files as Array<{ filename: string; additions: number; deletions: number; status: string }>).map((file) =>
        node('PullRequestChangedFile', { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }),
      );
    }
    if (field.name === 'pageInfo') {
      return node('PageInfo', { hasNextPage: source.hasNextPage as boolean, endCursor: source.endCursor as string | null });
    }
    if (field.name === 'totalCount') return source.totalCount as number;
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return source.path as string;
    if (field.name === 'additions') return source.additions as number;
    if (field.name === 'deletions') return source.deletions as number;
    if (field.name === 'changeType') return source.changeType as string;
  }

  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return source.hasNextPage as boolean;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return null;
    if (field.name === 'endCursor') return source.endCursor as string | null;
  }

  if (typeName === 'Branch') {
    if (field.name === 'name') return source.name as string;
  }

  if (typeName === '__Type') {
    if (field.name === 'name') return source.name as string;
    if (field.name === 'kind') return (source.enumValues as string[] | null) !== null ? 'ENUM' : 'OBJECT';
    if (field.name === 'description') return null;
    if (field.name === 'fields') {
      const fields = source.fields as string[] | null;
      if (fields === null) return null;
      return fields.map((name) => node('__Field', { name }));
    }
    if (field.name === 'enumValues') {
      const values = source.enumValues as string[] | null;
      if (values === null) return null;
      return values.map((name) => node('__EnumValue', { name }));
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return source.name as string;
    if (field.name === 'description') return null;
  }

  if (typeName === 'IssueEdge' || typeName === 'IssueCommentEdge') {
    if (field.name === 'node') return source.node as GqlNode;
    if (field.name === 'cursor') return source.cursor as string;
  }

  if (typeName === 'IssueComment') {
    if (field.name === 'id') return source.id as string;
    if (field.name === 'body') return source.body as string;
  }

  if (
    typeName === 'CreateIssuePayload' ||
    typeName === 'CloseIssuePayload' ||
    typeName === 'CreatePullRequestPayload' ||
    typeName === 'MergePullRequestPayload'
  ) {
    if (field.name === 'issue') return source.issue as GqlNode;
    if (field.name === 'pullRequest') return source.pullRequest as GqlNode;
    if (field.name === 'clientMutationId') return null;
  }

  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') return source.commentEdge as GqlNode;
    if (field.name === 'clientMutationId') return null;
  }

  return undefined;
}

function decodeRepoId(forge: Forge, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'Repository') return undefined;
  return forge.getRepoById(Number.parseInt(decoded.parts[0] as string, 10));
}

/** Execute a selection set on a node of `typeName`, collecting errors for unknown fields. */
function executeSelections(exec: Executor, typeName: string, source: GqlNode, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelections(exec, typeName, source, selection.selections);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const known = TYPE_FIELDS[typeName] ?? [];
    if (!known.includes(field.name)) {
      exec.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    const value = resolveField(exec, typeName, source, field);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (field.selections.length === 0) {
      out[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__type' in item) {
          return executeSelections(exec, (item as GqlNode).__type, item as GqlNode, field.selections);
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      const child = value as GqlNode;
      out[responseKey] = executeSelections(exec, child.__type, child, field.selections);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

/** Execute one operation document. Returns {data, errors}. */
export function executeOperation(
  forge: Forge,
  operation: GqlOperation,
  variables: Record<string, unknown>,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const exec: Executor = { forge, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = node(rootType, {});
  try {
    const data = executeSelections(exec, rootType, root, operation.selections);
    return { data, errors: exec.errors };
  } catch (err) {
    exec.errors.push({ message: (err as Error).message });
    return { data: null, errors: exec.errors };
  }
}

// -------------------------------------------------------------------------------------------------
// HTTP entry point: POST /api/graphql (a single operation, or a batch array, in order)
// -------------------------------------------------------------------------------------------------

export function handleGraphql(forge: Forge, req: HttpRequest): HttpResponse {
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    return jsonResponse(400, { errors: [{ message: 'request body is not valid JSON' }] });
  }
  const runOne = (item: unknown): Record<string, unknown> => {
    if (!isRecord(item) || typeof item.query !== 'string') {
      return { data: null, errors: [{ message: 'a GraphQL request needs a query string' }] };
    }
    const variables = isRecord(item.variables) ? (item.variables as Record<string, unknown>) : {};
    let operations: GqlOperation[];
    try {
      operations = new Parser(item.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: (err as Error).message }] };
    }
    const operation = operations[0];
    if (operation === undefined) {
      return { data: null, errors: [{ message: 'the document holds no operation' }] };
    }
    const { data, errors } = executeOperation(forge, operation, variables);
    return errors.length > 0 ? { data, errors } : { data, errors: [] };
  };
  if (Array.isArray(body)) {
    return jsonResponse(200, body.map(runOne));
  }
  return jsonResponse(200, runOne(body));
}
