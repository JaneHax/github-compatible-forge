# github-compatible-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JaneHax/github-compatible-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JaneHax/github-compatible-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process: git smart HTTP (upload-pack
protocol v2, receive-pack v0), the REST v3 API, the GraphQL v4 API and a Model Context Protocol
endpoint, all served from one in-memory store with no dependencies, no git binary and no outside
service.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`, the boot probe |
| `GET /api/v3/` | the REST API root, with `X-OAuth-Scopes` |
| `/api/v3/...` | repositories, branches, commits, contents, labels, issues, comments, pull requests, files, merges |
| `POST /api/graphql` | the documents `gh` and `github-mcp-server` send, plus introspection and batching |
| `POST /mcp` | JSON-RPC 2.0 over Streamable HTTP: `initialize`, `server/discover`, `tools/list`, `tools/call` |
| `/{owner}/{repo}.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | a JSON 404 |

## How it is built

- `gitobj.ts` — object hashing, pkt-line framing, tree/commit parsing, packfile read (OFS_DELTA and
  REF_DELTA) and write.
- `store.ts` — the store: repositories, refs, objects, issues, comments, labels, pull requests.
- `worktree.ts` — the tree edits the contents API and merges perform.
- `githttp.ts` — the smart-HTTP surface: the v2 capability advertisement, `ls-refs`, `fetch` with
  shallow boundaries, and `receive-pack` with per-ref report-status.
- `rest.ts` — the REST v3 resources and their GitHub shapes.
- `graphql.ts` — a small GraphQL engine: lexer, parser, executor, introspection.
- `mcp.ts` — the MCP endpoint and its six tools.
- `app.ts` — the router; `main.ts` — the entry lifecycle (bind an ephemeral port, register it, poll
  for done, exit 0).

Everything is standard library plus the vendored source in this repository. There is no package
manager step: the program imports `node:http`, `node:crypto`, `node:zlib` and its own files.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` needs `MAKEFUN_ENV_URL` (the env it registers with) and `MAKEFUN_SHOP_TOKEN` (the bearer
token every API call must carry). It binds an ephemeral port, `POST`s `{"port": N}` to
`$MAKEFUN_ENV_URL/register`, then polls `GET $MAKEFUN_ENV_URL/done` until the trial is over.

To drive it by hand, set both variables to a local stub and talk to the port it prints, or import
`createApp()` from `app.ts` and `listen(0)` yourself.

## License

MIT. See [LICENSE](LICENSE).

---

<sub>Entered on [make.fun](https://make.fun/?ref=853vjytx&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
