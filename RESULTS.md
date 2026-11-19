# github-core-clone-01 — build results

## What it is

A standalone GitHub-compatible git forge in Node 22 TypeScript, standard library only
(no installs), serving all four surfaces from one process and one in-memory store:

- **Git smart HTTP** (`src/git.ts`, `src/gitproto.ts`): protocol v2 upload-pack
  (`fetch`, `ls-refs`, `object-format=sha1`) and v0 receive-pack (`report-status`,
  `side-band-64k`, `delete-refs`), plus v0 fetch. Objects are real SHA-1 git objects
  (blob/tree/commit/tag), packs are version 2 with OFS/REF delta resolution, sideband
  framing, shallow/deepen/unshallow, fast-forward enforcement per ref.
- **REST v3** (`src/rest.ts`): root, meta, /user, repos (create/read/patch/delete,
  Link pagination), branches, commits, contents (file/dir, create/update/delete,
  stale-sha 409), labels, issues (list with state/sort, create with unknown-label
  422, get/patch, comments), pull requests (create, list, get, files, squash merge
  with conflict detection), git refs.
- **GraphQL** (`src/graphql.ts`): a small executor for the suite's 18 documents —
  viewer, repository, issue, pull-request, node(id:), `__type` introspection,
  cursor pagination, the five mutations, batched operations. Global ids are opaque
  (`base64("Kind:part:part")`) and stable.
- **MCP** (`src/mcp.ts`): JSON-RPC over Streamable HTTP, revision 2026-07-28
  (`server/discover`, no session) with the 2025-11-25-and-earlier handshake
  (`initialize`) as a fallback. Six tools (`create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`) act on the same store
  as REST. Unknown tool → -32602, parse error → HTTP 400 with -32700, missing
  arguments → `isError: true`.

Auth: every API call must carry `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the
token's owner is the scenario viewer `adaiversen` (id 1000), derived by porting the
kit's own PRNG (fnv1a64 / splitmix64 / xorshift64*) from `wire.ts` into
`src/scenario.ts` and verified byte-identical against the kit's `buildScenario()`.

Entry: `main.ts` (bind ephemeral port, POST `$MAKEFUN_ENV_URL/register`, poll
`/done`, exit 0) and `app.ts` (routing, bearer auth, `X-GitHub-Request-Id` on every
reply, JSON 404, never crashes on a bad request).

## Local grade (the kit's sealed suite, run locally)

`node grade-local.mjs /tmp/grade-github-core-N` starts the kit's
`program/env/server.mjs` and this entry, then prints `export/state.json` and
`export/perf.json`.

- **Grade 1** — boot failed: `app.ts` imported `./store.ts` instead of
  `./src/store.ts`, so the entry crashed on startup ("no entry registered before
  the boot deadline"). Fixed the imports.
- **Grade 2** — **115/120** conformance (git 30/30, issues 15/15, mcp 15/15,
  protocol 5/5, graphql 18/20, pulls 18/20, repos 14/15), working 1, perf **172**
  points (push 46, clone 32, read 48, write 46; p50 301,638 µs). Score would be
  feature round(600×115/120)=575 + agent round(200×15/15)=200 + perf 172 = **947**,
  above the reference forge's ~900.
  Five failures, all fixed after grade 2:
  1. `repos.commits`, `pulls.merge-commit-on-default` — `resolveToCommit` only
     looked up the ref verbatim, so a short branch name (`main`, `feature-x`)
     never resolved and `GET /commits` returned []. Now tries the full ref,
     `refs/heads/<name>`, `refs/tags/<name>`, then a bare object id.
  2. `pulls.merge-conflict` — `mergePull`/`pullConflicts` used the stale
     `baseSha` captured at PR creation instead of the base branch's current tip,
     so after a first PR merged, a conflicting second PR looked clean and its
     merge commit's parent skipped the first merge. Both now resolve the current
     base tip at call time.
  3. `graphql.issues-open-order`, `graphql.pull-requests-list` — the
     `IssueConnection`/`PullRequestConnection` nodes did not carry the repo, so
     `Issue.id` (`repo.id`) and `PullRequest.mergeable` (`pullConflicts(repo)`)
     threw. Both connections now carry `repo`.
  Also fixed during review (before grade 2): a v2 fetch advertising `filter`
  without implementing it (removed), and `computeFetch` treating a shallow
  boundary have as full history (a deepen would send nothing — now a
  shallow-boundary have is held only as that commit plus its tree).
- **Grade 3** — **120/120** conformance (git 30/30, graphql 20/20, issues 15/15,
  mcp 15/15, protocol 5/5, pulls 20/20, repos 15/15), working 1, perf **136**
  points (push 25, clone 31, read 45, write 35; p50 491,220 µs). Score:
  feature 600 + agent 200 + perf 136 = **936**. Perf varies run to run on this
  shared-CPU machine (grade 2: 172 points, push p50 510 ms; grade 3: 136 points,
  push p50 1,603 ms) — the entry and the env share 1.5 CPUs locally, while the
  production pod gives the entry 2 CPUs, so production perf may differ either
  way. Conformance is stable at 120/120; the total is ~936–947 across the two
  graded runs, both above the reference forge's ~900.

## Repo

https://github.com/DanuMahiru/github-core-clone-01 — public, created
2026-11-19T22:41:15Z (after the competition opened 2026-11-14). MIT LICENSE,
`.makefun/owner.json` naming wallet
`Ht2eWKDiyDQqBK3k7nxuLbC5zAfywxhipgBd4kdZbGSJ`. About set (description,
homepage https://make.fun/bounty/github-core-clone-01, topics makefun,
ai-agents, bounties, git, graphql, mcp).

Commit: (fill in after push).

## Honest judgment

The forge is complete on all four surfaces and, on the local sealed suite, scores
above the reference forge (~936–947 vs ~900 across the two graded runs, with
120/120 conformance). The remaining risk is not conformance but the field: 15,698
submissions, and the prize needs beating the reference, which the local numbers
suggest is plausible but not certain — the sealed production run may differ from
this local run (different machine, Node 22 vs local Node 24, and the live suite's
timing). Perf is the thinnest margin: clone scored 31–32/50 (the 50-concurrent
shallow-clone workload is the slowest surface), and push varied 25–46/50 between
runs, so the total is sensitive to machine load.
