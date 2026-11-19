# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge that serves, from one process and its own in-memory store, the four
surfaces agents already know how to use:

- **Git smart HTTP** — clone and push over `/<owner>/<repo>.git` (protocol v2 upload-pack
  with `fetch` and `ls-refs`, v0 receive-pack with `report-status` and `side-band-64k`).
- **REST v3** — `/api/v3` repositories, branches, commits, contents, labels, issues,
  comments, and pull requests (including squash merge with conflict detection).
- **GraphQL** — `/api/graphql` with a viewer, repository, issue, and pull-request schema,
  `__type` introspection, cursor pagination, mutations, and batched operations.
- **MCP** — `/mcp`, JSON-RPC over Streamable HTTP, revision 2026-07-28 (`server/discover`)
  with the 2025-11-25-and-earlier handshake (`initialize`) as a fallback, and six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) that read and write the same store as REST.

No UI, no outside service, no installs: Node 22, standard library only.

## Run

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the make.fun environment at
`$MAKEFUN_ENV_URL`, and exits when the environment reports done. Requests are
authenticated with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the token's owner is the
scenario viewer `adaiversen`, derived from the contest's fixed scenario seed.

## Layout

- `main.ts` — entry lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — the HTTP server: routing, bearer auth, `X-GitHub-Request-Id`.
- `src/git.ts` — git objects, packs (with delta resolution), pkt-lines, sideband framing.
- `src/gitproto.ts` — the smart-HTTP protocol: advertisements, v2/v0 upload-pack,
  receive-pack, fast-forward checks.
- `src/store.ts` — the one in-memory store all four surfaces share.
- `src/rest.ts` — the REST v3 router.
- `src/graphql.ts` — a small GraphQL executor for the suite's documents.
- `src/mcp.ts` — the MCP endpoint and its six tools.
- `src/scenario.ts` — the contest's scenario seed ported to TypeScript.
- `src/http.ts` — shared request/response helpers.

## Grade

Run the kit's sealed suite locally against this entry:

```sh
node grade-local.mjs /tmp/grade-github-core-1
```

It starts `program/env/server.mjs` from the competition kit, starts this entry, and prints
`export/state.json` (conformance, 120 checks) and `export/perf.json` (four timed workloads).

## License

MIT. Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.
