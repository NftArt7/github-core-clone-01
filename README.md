# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/NftArt7/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/NftArt7/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process GitHub-compatible git forge: smart HTTP (v0 and v2 upload-pack, receive-pack), REST v3, GraphQL, and MCP — with no git binary and no external services. Written in TypeScript, run with Node 22+ via `--experimental-strip-types`.

The forge keeps repositories, objects, issues, and pull requests in memory, implements the git pack format (including OFS/REF delta decoding), fast-forward-only pushes, three-way squash merges with conflict detection, and the full REST/GraphQL/MCP surface the make.fun conformance suite exercises.

## Run it

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
