// The forge's store: every repository, ref, issue, pull request, comment and label, held in
// memory in one process. The git, REST, GraphQL and MCP surfaces all read and write this one
// store, so a repository created over MCP reads back over REST as the same object.

import {
  ObjectStore,
  buildCommit,
  buildTree,
  countLines,
  diffTrees,
  flattenTree,
  getEntryAtPath,
  identLine,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  removePath,
  setPath,
  type FileChange,
  type GitObject,
} from './git.ts';
import { SCENARIO_EPOCH_SEC, type ScenarioUser } from './scenario.ts';

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  issueSeq: number;
  pulls: PullRequest[];
  prSeq: number;
  comments: Map<number, Comment[]>;
  commentSeq: number;
  /**
   * Memoized upload-pack response bodies, keyed by the fetch parameters plus the
   * object-store size (v2 perf: the clone workload fires 50 concurrent shallow
   * clones of the same tip, and every one of them rebuilt the identical pack).
   * The key is sound because the store is content-addressed and only grows within
   * a repo's lifetime — same size plus same parameters means same bytes — and the
   * cache dies with the repo when the repo is deleted. Capped by the caller.
   */
  packCache: Map<string, Buffer>;
  createdAt: string;
  updatedAt: string;
}

export type IssueState = 'open' | 'closed' | 'all';

/** An opaque Relay global id: base64 of "Kind:part:part". Never a plain number. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

/** Decode a global id made by globalId, or null when it is not one. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const kind = text.slice(0, colon);
    if (kind === '') return null;
    return { kind, parts: text.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

const nowIso = (): string => new Date().toISOString();

/** The forge: one store for all four surfaces. */
export class Forge {
  readonly viewer: ScenarioUser;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextEntityId = 1;
  /** A deterministic clock for server-made git commits (replay-stable). */
  private commitClock = SCENARIO_EPOCH_SEC;

  constructor(viewer: ScenarioUser) {
    this.viewer = viewer;
  }

  /** The next deterministic commit timestamp (seconds since the epoch). */
  nextCommitTime(): number {
    this.commitClock += 1;
    return this.commitClock;
  }

  // -------------------------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      objects: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      issueSeq: 1,
      pulls: [],
      prSeq: 1,
      comments: new Map(),
      commentSeq: 1,
      packCache: new Map(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  // -------------------------------------------------------------------------------- refs

  /** The tip of a branch, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Every branch name in the repo. */
  branchNames(repo: Repo): string[] {
    const names: string[] = [];
    for (const ref of repo.refs.keys()) {
      if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
    }
    return names.sort();
  }

  /** The commit a ref points at, resolving annotated tags to their target commit. */
  /** Resolve a ref to a commit: a full ref, a short branch or tag name, or a bare object id. */
  resolveToCommit(repo: Repo, ref: string): string | null {
    for (const candidate of [ref, `refs/heads/${ref}`, `refs/tags/${ref}`]) {
      const oid = repo.refs.get(candidate);
      if (oid !== undefined) return this.peelToCommit(repo, oid);
    }
    if (repo.objects.has(ref)) return this.peelToCommit(repo, ref);
    return null;
  }

  /** Follow tag objects to the commit they point at (or null when it is not a commit). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 10; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        const text = object.data.toString('utf8');
        const match = /^object ([0-9a-f]{40})$/m.exec(text);
        if (match === null) return null;
        current = match[1] as string;
        continue;
      }
      return null;
    }
    return null;
  }

  /** Create or move a ref to a commit. Returns false when the commit is not held. */
  setRef(repo: Repo, ref: string, sha: string): boolean {
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    repo.updatedAt = nowIso();
    return true;
  }

  // -------------------------------------------------------------------------------- commits

  /** The commits reachable from a ref, newest first (by walk order). */
  listCommits(repo: Repo, ref: string): Array<{ sha: string; message: string }> {
    const tip = this.resolveToCommit(repo, ref);
    if (tip === null) return [];
    const out: Array<{ sha: string; message: string }> = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha)) continue;
      seen.add(sha);
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha, message: commit.message });
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  /**
   * Make a commit on `branch` (creating the branch when needed) with `treeSha` as its tree.
   * Returns the new commit's id.
   */
  makeCommit(repo: Repo, branch: string, treeSha: string, message: string): string {
    const parent = this.branchTip(repo, branch);
    const epochSec = this.nextCommitTime();
    const ident = identLine(this.viewer.name, this.viewer.email, epochSec);
    const commit = buildCommit({
      tree: treeSha,
      parents: parent === null ? [] : [parent],
      author: ident,
      committer: ident,
      message,
    });
    const sha = repo.objects.put('commit', commit);
    repo.refs.set(`refs/heads/${branch}`, sha);
    repo.updatedAt = nowIso();
    return sha;
  }

  /** The tree a branch tip points at, or null for an unborn branch. */
  branchTree(repo: Repo, branch: string): string | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  // -------------------------------------------------------------------------------- contents

  /** Read a file or directory at `path` on `branch` (null branch = default branch). */
  readContents(
    repo: Repo,
    path: string,
    branch: string | null,
  ): { kind: 'file'; entry: { mode: string; name: string; sha: string; type: string }; data: Buffer } | { kind: 'dir'; entries: Array<{ mode: string; name: string; sha: string; type: string }> } | null {
    const treeSha = this.branchTree(repo, branch ?? repo.defaultBranch);
    if (treeSha === null) return null;
    const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (clean === '') {
      const object = repo.objects.get(treeSha);
      if (object === undefined) return null;
      const entries = parseTree(object.data).map((entry) => ({
        mode: entry.mode,
        name: entry.name,
        sha: entry.sha,
        type: entry.mode === '40000' ? 'dir' : 'file',
      }));
      return { kind: 'dir', entries };
    }
    const entry = getEntryAtPath(repo.objects, treeSha, clean);
    if (entry === null) return null;
    if (entry.type === 'blob') {
      const object = repo.objects.get(entry.sha);
      if (object === undefined) return null;
      return { kind: 'file', entry, data: object.data };
    }
    const object = repo.objects.get(entry.sha);
    if (object === undefined) return null;
    const entries = parseTree(object.data).map((item) => ({
      mode: item.mode,
      name: item.name,
      sha: item.sha,
      type: item.mode === '40000' ? 'dir' : 'file',
    }));
    return { kind: 'dir', entries };
  }

  /**
   * Write a file at `path` on `branch`, creating the branch from the default branch when it
   * does not exist yet. Returns the new blob id and commit id.
   */
  writeContents(
    repo: Repo,
    path: string,
    content: Buffer,
    message: string,
    branch: string | null,
  ): { blobSha: string; commitSha: string } {
    const target = branch ?? repo.defaultBranch;
    let treeSha = this.branchTree(repo, target);
    if (treeSha === null && target !== repo.defaultBranch) {
      // A new branch starts from the default branch's tip.
      const defaultTip = this.branchTip(repo, repo.defaultBranch);
      if (defaultTip !== null) repo.refs.set(`refs/heads/${target}`, defaultTip);
      treeSha = this.branchTree(repo, target);
    }
    const blobSha = repo.objects.put('blob', content);
    const newTree = setPath(repo.objects, treeSha, path, blobSha);
    const commitSha = this.makeCommit(repo, target, newTree, message);
    return { blobSha, commitSha };
  }

  /** Delete a file at `path` on `branch`. Returns the new commit id, or null when absent. */
  deleteContents(repo: Repo, path: string, message: string, branch: string | null): string | null {
    const target = branch ?? repo.defaultBranch;
    const treeSha = this.branchTree(repo, target);
    if (treeSha === null) return null;
    if (getEntryAtPath(repo.objects, treeSha, path) === null) return null;
    const newTree = removePath(repo.objects, treeSha, path);
    const emptyTree = repo.objects.put('tree', buildTree([]));
    return this.makeCommit(repo, target, newTree ?? emptyTree, message);
  }

  // -------------------------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextEntityId++,
      number: repo.issueSeq++,
      title,
      body,
      state: 'open',
      labels,
      userLogin: this.viewer.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
    };
    repo.issues.push(issue);
    repo.comments.set(issue.number, []);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, state: IssueState): Issue[] {
    if (state === 'all') return repo.issues.slice();
    return repo.issues.filter((issue) => issue.state === state);
  }

  setIssueState(repo: Repo, number: number, state: 'open' | 'closed'): Issue | undefined {
    const issue = this.getIssue(repo, number);
    if (issue === undefined) return undefined;
    issue.state = state;
    issue.updatedAt = nowIso();
    issue.closedAt = state === 'closed' ? nowIso() : null;
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): Comment | undefined {
    const issue = this.getIssue(repo, issueNumber);
    if (issue === undefined) return undefined;
    const comment: Comment = {
      id: this.nextEntityId++,
      body,
      userLogin: this.viewer.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  listComments(repo: Repo, issueNumber: number): Comment[] {
    return (repo.comments.get(issueNumber) ?? []).slice();
  }

  // -------------------------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === null) return { error: `head branch "${head}" does not exist` };
    if (baseSha === null) return { error: `base branch "${base}" does not exist` };
    const duplicate = repo.pulls.find(
      (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
    );
    if (duplicate !== undefined) return { error: 'a pull request already exists for this head and base' };
    const pull: PullRequest = {
      id: this.nextEntityId++,
      number: repo.prSeq++,
      title,
      body,
      state: 'open',
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      userLogin: this.viewer.login,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      closedAt: null,
    };
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state: 'open' | 'closed' | 'all'): PullRequest[] {
    if (state === 'all') return repo.pulls.slice();
    return repo.pulls.filter((pull) => pull.state === state);
  }

  /** The files a pull request changes (merge-base of head/base against head). */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const base = mergeBase(repo.objects, pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    return diffTrees(repo.objects, baseTree, headTree).map((change) => ({
      ...change,
      status: change.status === 'removed' ? 'removed' : change.status,
    }));
  }

  commitTree(repo: Repo, sha: string): string | null {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Whether a pull request's head conflicts with its base (same file changed both sides). */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    // The base tip is resolved at call time, not from the sha captured when the pull
    // request was opened: another pull request may have merged onto the base since.
    const baseTipSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.objects, pull.headSha, baseTipSha);
    if (base === null) return true;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    const baseTipTree = this.commitTree(repo, baseTipSha);
    const headChanges = flattenTree(repo.objects, headTree);
    const baseChanges = flattenTree(repo.objects, baseTree);
    const tipChanges = flattenTree(repo.objects, baseTipTree);
    for (const [path, headEntry] of headChanges) {
      const baseEntry = baseChanges.get(path);
      if (baseEntry === undefined) continue;
      if (baseEntry.sha === headEntry.sha) continue;
      const tipEntry = tipChanges.get(path);
      if (tipEntry === undefined) return true;
      if (tipEntry.sha !== baseEntry.sha && tipEntry.sha !== headEntry.sha) return true;
    }
    for (const [path, baseEntry] of baseChanges) {
      if (headChanges.has(path)) continue;
      const tipEntry = tipChanges.get(path);
      if (tipEntry !== undefined && tipEntry.sha !== baseEntry.sha) return true;
    }
    return false;
  }

  /**
   * Merge a pull request by squash: the head's changes, applied onto the base tip, as one
   * commit. Returns the merge commit id, or null when the pull conflicts.
   */
  mergePull(repo: Repo, pull: PullRequest): string | null {
    if (pull.state !== 'open') return null;
    if (this.pullConflicts(repo, pull)) return null;
    // The base tip is resolved at merge time: the merge commit's parent is the branch's
    // current tip, so the history stays connected when another pull request merged first.
    const baseTipSha = this.branchTip(repo, pull.baseRef) ?? pull.baseSha;
    const base = mergeBase(repo.objects, pull.headSha, baseTipSha);
    const baseTree = base === null ? null : this.commitTree(repo, base);
    const headTree = this.commitTree(repo, pull.headSha);
    const baseTipTree = this.commitTree(repo, baseTipSha);
    if (headTree === null || baseTipTree === null) return null;
    // Apply the head's file changes onto the base tip's tree.
    const headFiles = flattenTree(repo.objects, headTree);
    const baseFiles = flattenTree(repo.objects, baseTree);
    let tree = baseTipTree;
    for (const [path, headEntry] of headFiles) {
      const baseEntry = baseFiles.get(path);
      if (baseEntry !== undefined && baseEntry.sha === headEntry.sha) continue;
      tree = setPath(repo.objects, tree, path, headEntry.sha);
    }
    for (const [path, baseEntry] of baseFiles) {
      if (headFiles.has(path)) continue;
      void baseEntry;
      tree = removePath(repo.objects, tree, path) ?? repo.objects.put('tree', buildTree([]));
    }
    const epochSec = this.nextCommitTime();
    const ident = identLine(this.viewer.name, this.viewer.email, epochSec);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const commit = buildCommit({
      tree,
      parents: [baseTipSha],
      author: ident,
      committer: ident,
      message,
    });
    const mergeSha = repo.objects.put('commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = mergeSha;
    pull.closedAt = nowIso();
    pull.updatedAt = nowIso();
    repo.updatedAt = nowIso();
    return mergeSha;
  }

  // -------------------------------------------------------------------------------- serializers

  userJson(login: string): Record<string, unknown> {
    const user = login === this.viewer.login ? this.viewer : { id: 0, login, name: login, email: `${login}@example.invalid` };
    return { login: user.login, id: user.id, type: 'User', name: user.name, email: user.email };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      node_id: globalId('Repository', repo.id),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: this.userJson(repo.owner),
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      archived: false,
      disabled: false,
      visibility: repo.private ? 'private' : 'public',
      forks_count: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
      watchers_count: 0,
      stargazers_count: 0,
    };
  }

  labelJson(label: Label): Record<string, unknown> {
    return { name: label.name, color: label.color, description: '', default: false };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      node_id: globalId('Issue', repo.id, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      locked: false,
      labels: issue.labels.map((label) => this.labelJson(label)),
      user: this.userJson(issue.userLogin),
      assignees: [],
      milestone: null,
      comments: (repo.comments.get(issue.number) ?? []).length,
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      closed_at: issue.closedAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      node_id: globalId('IssueComment', repo.id, issueNumber, comment.id),
      body: comment.body,
      user: this.userJson(comment.userLogin),
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    };
  }

  pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
    return {
      id: pull.id,
      node_id: globalId('PullRequest', repo.id, pull.number),
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      locked: false,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: this.userJson(pull.userLogin),
      merged: pull.merged,
      mergeable: !this.pullConflicts(repo, pull),
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      created_at: pull.createdAt,
      updated_at: pull.updatedAt,
      closed_at: pull.closedAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    };
  }

  branchJson(repo: Repo, branch: string): Record<string, unknown> | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    return { name: branch, commit: { sha: tip }, protected: false };
  }

  commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    return {
      sha,
      commit: {
        message: commit.message,
        author: { name: this.viewer.name, email: this.viewer.email, date: new Date().toISOString() },
        committer: { name: this.viewer.name, email: this.viewer.email, date: new Date().toISOString() },
      },
      author: this.userJson(this.viewer.login),
      committer: this.userJson(this.viewer.login),
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  }

  /** The number of lines in a blob, for pull-request file stats. */
  blobLineCount(repo: Repo, sha: string): number {
    const object = repo.objects.get(sha);
    if (object === undefined) return 0;
    return countLines(object.data);
  }
}

export { isAncestor };
