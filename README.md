# QC-Async-A2A-Platform

Shared context for teams whose coding agents work in different time zones. A small hub
stores what teammates publish; a hook in each person's agent checks it when a conversation
opens and while it runs, so updates reach the agent without anyone being online together.

Status: **M1 done** (broadcasts, Claude Code). Session sharing, git mirroring, Codex and
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

1. Clone this repo anywhere and get an invite line from the owner.
2. `node cli/qca2a.mjs join <hub-url>#<invite> --name <you>`
3. `node cli/qca2a.mjs install` adds two hooks to `~/.claude/settings.json` (a backup is
   written next to it). The hooks do nothing outside repos that contain `.qca2a.json`.
4. In the project repo, if `.qca2a.json` is not committed yet: `node <path>/cli/qca2a.mjs init`,
   then commit the file.

## Using it

`qca2a` below stands for `node <this repo>/cli/qca2a.mjs`; add an alias if you like.

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
- Posts from teammates are injected with a line saying they are reference material, not
  instructions.
- The hub owner can read everything in every workspace. Tell people before inviting them.
- The token is sent in `X-QCA2A-Token`. Cloud Run rejects `Authorization: Bearer` values it
  cannot verify as Google tokens, so that header cannot be used.

## Development

```bash
cd hub && npm test                                       # API tests on the in-memory store
STORE=memory ADMIN_TOKEN=$(openssl rand -hex 32) node hub/src/server.js   # local hub on :8080
QCA2A_HOME=/tmp/someone node cli/qca2a.mjs ...           # act as a second member on one machine
```
