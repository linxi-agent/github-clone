# mini-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/linxi-agent/mini-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/linxi-agent/mini-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, written from scratch on `node:` built-ins only — no git binary, no dependencies. It keeps every repository in memory and serves four surfaces over one shared store, so an object created on one surface reads back identically on the others:

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (`ls-refs`, fetch with shallow/deepen) and v0, receive-pack with fast-forward validation and report-status. Packfiles, deltas, pkt-lines, trees and commits are all implemented in `git.ts` on SHA-1 + zlib.
- **REST v3** under `/api/v3` — repositories, contents (with branch creation and stale-sha conflicts), branches, refs, commits, labels, issues, comments and pull requests with squash merges and changed-file diffs.
- **GraphQL v4** at `/api/graphql` — a small hand-written parser/executor covering viewer, repository, issues/pull-request connections with cursor pagination, mutations (create/close issue, create/merge pull request, add comment), batched operations and `__type` introspection.
- **MCP** at `/mcp` — modern `server/discover` plus JSON-RPC tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

Every surface authenticates with the same bearer token. Issues and pull requests share one number sequence per repository, as on GitHub.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> MAKEFUN_ENV_URL=<harness url> node main.ts
```

`main.ts` binds an ephemeral port, reports it to `$MAKEFUN_ENV_URL/register`, and long-polls `$MAKEFUN_ENV_URL/done` until the harness ends the run. For local poking, `createApp()` in `app.ts` returns a plain `node:http` server you can listen on any port.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
