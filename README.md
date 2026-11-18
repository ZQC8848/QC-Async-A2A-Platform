# QC-Async-A2A-Platform

Shared context for teams whose coding agents work in different time zones. A small hub
stores what teammates publish; a hook in each person's agent checks it when a conversation
opens and while it runs, so updates reach the agent without anyone being online together.

Status: **M1 done** (broadcasts, Claude Code, per-repo opt-in). Session sharing, git mirroring, Codex and
Cursor are next; see [docs/design.md](docs/design.md).

## Parts

| Path | What |
|---|---|
| `hub/` | The service on Cloud Run. Node, no dependencies, Firestore over REST. |
| `cli/qca2a.mjs` | The client and the hook entry point. One file, no dependencies, Node >= 18. |
| `deploy/` | GCP setup and deploy scripts. |

Hub: `https://hub-4312801598.us-west1.run.app` (GCP project `qc-async-a2a-platform`, us-west1,
scales to zero, so the first request after idle takes a second or two).

## Joining as a teammate

Needs Node >= 18, git, and an invite line from the workspace owner. No Google account.

```bash
npm install -g github:ZQC8848/QC-Async-A2A-Platform#v0.2.0
qca2a join <hub-url>#<invite> --name <you>
cd <the project repo>
qca2a enable
```

`qca2a enable` is the opt-in, per repo and per machine. It writes two Claude Code hooks to
that repo's `.claude/settings.local.json`, keeps the file out of git through
`.git/info/exclude`, and records the repo in `~/.config/qca2a/enabled.json`. Nothing is
added to user-level settings, so agents in your other projects have no hook at all.
The hooks apply to new conversations started in the repo, its subdirectories and its git
worktrees. `qca2a disable` removes them; `qca2a whoami` shows what is enabled.

If the repo has no `.qca2a.json` yet, one person runs `qca2a init` there first and commits
the file. That file only says which workspace the repo belongs to. It does not turn
anything on for anyone: a teammate who has not run `qca2a enable` is not affected by it.

To update, run the `npm install` line again with the newer tag, then `qca2a enable` in
each enabled repo (the hooks record the absolute path of Node and of the client).
`qca2a --version` shows what is installed.

## Using it

```bash
qca2a post --type decision --title "Use Marble 1.1" --body "Why..." --to weibo --link docs/design.md
qca2a inbox            # unread posts
qca2a show <id>        # print one and mark it read
qca2a posts            # recent posts and who has read them
```

Types: `note` (minutes, FYI), `decision`, `task`, `notice`. `--to` addresses members by name.
Long content belongs in the repo; post a summary and `--link` the file.

What the agent sees: on a new or resumed conversation, the titles of everything unread; in a
running conversation, only posts that arrived since the last check (at most every 10 minutes).
Nothing is injected when there is nothing new, and the hook exits silently if the hub is
unreachable.

## Owner tasks

```bash
source ~/.config/qca2a/admin.env                 # admin token, created by setup-gcp.sh
export QCA2A_HUB=https://hub-4312801598.us-west1.run.app
qca2a admin ws-create "Team / Project"           # one workspace per team x project
qca2a admin invite <workspace-id> --uses 3       # prints the join line to send privately
qca2a admin ws-list
qca2a admin revoke <member-id>
deploy/deploy.sh                                 # build and redeploy the hub
```

## Security model

- A member token is tied to one person; the hub stores only its hash. Every workspace
  request checks membership, and a non-member gets the same answer as for a workspace that
  does not exist.
- Tokens live in `~/.config/qca2a/credentials.json` (mode 0600), never in a repo.
  `.qca2a.json` holds only the hub URL and workspace id.
- A hook acts only when three things hold on that machine: the repo was enabled there, it
  still has a binding, and the binding names the workspace that was enabled. Someone
  committing or changing a `.qca2a.json` cannot opt you in.
- Posts from teammates are injected with a line saying they are reference material, not
  instructions.
- The hub owner can read everything in every workspace. Tell people before inviting them.
- The token is sent in `X-QCA2A-Token`. Cloud Run rejects `Authorization: Bearer` values it
  cannot verify as Google tokens, so that header cannot be used.

## License

MIT

## Development

```bash
cd hub && npm test                                       # API tests on the in-memory store
STORE=memory ADMIN_TOKEN=$(openssl rand -hex 32) node hub/src/server.js   # local hub on :8080
QCA2A_HOME=/tmp/someone node cli/qca2a.mjs ...           # act as a second member on one machine
```

From a clone, `node cli/qca2a.mjs` is the same as the installed `qca2a`.

```bash
npm install -g .                                         # install the working copy
```
