# Quest Board

An 8-bit quest log for your repositories. Quest Board is a local web UI over
[Quest](https://github.com/moq-dev/quest) trees, the `quest/` folders of
Markdown plans that you and your agents read, claim, and finish. Point it at
one repository or many and see every quest in one place.

- **Board:** one column per milestone, with each quest's size, status, how
  many quests it unblocks, and its claim PR.
- **Map:** the `## Required` links as a graph, blockers on the left and
  dependents on the right. Click a quest to trace its whole chain.
- **Inbox:** every `## Waiting` item, the maintainer's first, then those
  waiting on outside parties. "You" here means the `Maintainer` party, as in
  the Quest guide; any other party is "others".
- **Actions:** claim a ready quest (`quest start`), release a claim
  (`quest start --release`), see why a quest is blocked, open its file.

It has no dependencies and nothing to build. It runs on your machine and
talks only to the `quest` and `gh` commands you already use.

## Requirements

- Node.js 20 or later
- The [`quest`](https://github.com/moq-dev/quest#try-it) CLI on your `PATH`,
  which ranks ready work and claims quests
- Optional: the [`gh`](https://cli.github.com) CLI, logged in, to show which
  quests are claimed by open PRs

## Run it

```sh
git clone https://github.com/steelhead99x/quest-board.git
cd quest-board
node server.mjs ~/code/my-repo ~/code/other-repo
```

Then open <http://127.0.0.1:4577>. Each repository you name is added to your
project list, so next time `node server.mjs` alone is enough. You can also add
and remove projects from the **Projects** button.

`npm link` installs a `quest-board` command.

| Option / variable    | Meaning                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `--port`, `PORT`     | Port to listen on (default 4577)                                        |
| `HOST`               | Address to bind (default `127.0.0.1`)                                   |
| `QUEST_BOARD_CONFIG` | Project list file (see below)                                           |
| `QUEST_BIN`, `GH_BIN` | Paths to the `quest` and `gh` commands                                 |

The project list defaults to `$XDG_CONFIG_HOME/quest-board/projects.json` when
`XDG_CONFIG_HOME` is set, else `%APPDATA%\quest-board\projects.json` on Windows,
else `~/.config/quest-board/projects.json`. A leading `~/` or `~\` in a path
means your home folder. Paths you add are stored absolute, or in `~/` form if
you gave one. The project list is plain JSON:

```json
[{ "name": "my-repo", "path": "~/code/my-repo" }]
```

## How it reads a tree

Quest Board parses `quest/**/*.md` itself for titles, sizes (`# [M] Title`),
goals, plans, `Required` and `Related` links, `Waiting` items, and
`Scheduled` dates. Readiness and the "unblocks" count come from
`quest unblocked --json`, so they match the CLI exactly. A ready quest is
**Needs you** when a `Waiting` item names the `Maintainer`, and **Waiting**
when it waits only on outside parties. An epic or milestone README counts as
a quest once the CLI ranks it as ready (its children are done); until then it
is an **Epic**.

A quest counts as claimed when an open PR's branch is the quest's path
without `.md`, the branch `quest start` creates. Claims come from
`gh pr list --state open --limit 500`, so a repository with more than 500 open
PRs may show some claimed quests as ready, and the PR list only covers the
repository `gh` resolves for the checkout (not forks).

## Security

The server binds to `127.0.0.1` and refuses any request whose `Host` is not
`127.0.0.1`, `localhost`, `[::1]` (or the `HOST` you set) on its own port, which
blocks DNS-rebinding pages. It also refuses POST requests from other origins
or without its own header, and serves a strict Content-Security-Policy
(no inline scripts, no framing). Actions run only the `quest` and `gh` commands,
only on a document that exists in a configured tree. Claim and release change
GitHub, so the UI asks before running them. Do not expose the server on a
network you do not trust.

The theme loads two fonts from Google Fonts and falls back to your system's
monospace font when offline.

## Develop

```sh
npm test        # node --test
npm run check   # syntax check
```

Quest Board is not affiliated with the Quest project. Licensed under either of
[Apache-2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT), at your option.
