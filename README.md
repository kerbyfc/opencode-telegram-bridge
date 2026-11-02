# opencode-telegram-bridge

The OpenCode side of the Telegram bridge. Your words from a Telegram topic arrive in a session as a
new prompt, a command written in the topic runs as if you typed it in the terminal, and the agent's
finished replies go back to the topic.

The plugin is only the session-side half. It **does not work on its own**: it talks to a local
service, [`telegram-bridge`](https://github.com/kerbyfc/telegram-bridge), which polls the Telegram
Bot API and keeps topics, sessions and the owner's inbox. The protocol between the service, the thin
client and the session adapter is `contract.md` in that repository.

**Both clients are equal.** Nothing in the topic shows which client is behind a session: delivery
marks, the reply stream, the topic's behaviour and command execution are all the service's business,
and the plugin has no topic behaviour of its own. What OpenCode has of its own is one line at the
bottom of its window with the topic name.

## What it does

- **Your words become prompts.** A message you write in the session's topic is submitted as a user
  prompt with its provenance on the first lines. A running turn is not steered; an idle session is
  woken with a new turn. The plugin confirms the delivery to the service, which marks your message:
  🫡 taken by the agent, 😴 held.
- **Commands from the topic run in the session.** A slash command written in the topic (other than
  the ones the service handles itself) runs through the client's command call.
- **Agent replies go to the topic.** The server's `session.text.ended` event carries a finished text
  block whole; tool calls, their input and thinking never reach the topic.
- **Turn boundaries and liveness.** Every start and end of a turn is reported, so the topic shows
  "typing…" while the session works.
- **`/away [topic name]` and `/here`** switch away mode for the session. The mode itself lives in
  the service; the plugin only calls `telegram-bridge away on|off --session <id>` and shows the
  outcome in the session.
- **Questions with options.** A `tool.execute.before` handler on the `question` tool forwards the
  question to `telegram-bridge hook ask`, so in away mode the question reaches the topic instead of
  opening a dialog where nobody is looking.
- **The topic's name is the chat's name.** Until you name the topic yourself, the topic is called
  after the chat: the session's title comes from the client's own session record and from the
  `session.renamed` event, and the plugin tells it to the service as an ordinary name when the
  connection opens and on every rename — right away, without waiting for your word. A name you type,
  `/away <name>` in the session or in the topic, wins over the chat's name and stays until you give
  another one. A session without a title falls back to the bound topic and `default_topic_name`.
- **The status line** at the bottom of the OpenCode window shows `TG: <topic name>` while the session
  has a topic.

Everything the plugin says about a lost channel goes to the server's error stream and, once per
session, into the session itself as a synthetic message (`◈ …`), which does not start a turn.

## Requirements

- OpenCode 2.1.4 or later, with plugins loaded from a Git address.
- The `telegram-bridge` binary on `PATH`, or its full path in `DM_TELEGRAM_BRIDGE`.
- `DM_TELEGRAM_CONFIG` in the environment of the OpenCode server: the path to the service's
  `config.yaml`. The plugin does not read it; `telegram-bridge link` does.
- A running `telegram-bridge` service and a Telegram bot that administers a forum group (topics).

## Installation

Name the plugin by its Git address in the OpenCode settings — the plugin lives at the root of this
repository, so the address has no `::path:` suffix:

```json
{
  "plugins": ["git+https://github.com/kerbyfc/opencode-telegram-bridge#v0.1.0"]
}
```

A plugin placed in `.opencode/plugins/` is picked up automatically; a plugin named by address must be
listed under `plugins`, and the server log then shows a `loading plugin` line with its path.

## Commands

| Command | What it does |
|---|---|
| `/away [topic name]` | turns away mode on for this session: `telegram-bridge away on [name] --session <id>` |
| `/here` | turns it off: `telegram-bridge away off --session <id>` |

The session id comes from the command invocation itself, not from the environment. The outcome is
shown in the session as the bridge's own line (a synthetic message that does not start a turn): the
subcommand's line and the way back, or its reason on failure. Nothing is written to the topic, and
the command carries no instructions for the model: away mode is transparent to it either way.

## What OpenCode has of its own, and why

| Own thing | Why, in OpenCode's own design |
|---|---|
| several connections, one per session | Claude Code has one process per session, while the plugin lives in a server that holds many sessions at once |
| which sessions count as alive | OpenCode does not measure "alive" by a process: a session stays in the server after its owner has left it |
| `session.prompt` with `queue` delivery, `steer` while a bridge line is in the server inbox and no turn is running | the client's own call; `queue` means "waits for a turn boundary", so a running turn is not steered by your word. OpenCode 2.1.4 takes `steer` entries from the inbox first, so a queued word would wake a turn that sees only a bridge line, and the word itself would arrive on the next turn |
| commands through `session.command` | the client's own call; it waits for a turn boundary and therefore does not hold a turn |
| telling you about the bridge with a synthetic message | a plugin has no dim terminal line as the Claude Code mod has; a synthetic message does not start a turn (`resume: false`) and the window shows it as one line of its description |
| one holder registry per process | one server loads the plugin several times, while the protocol has one connection per session |
| the topic name at the bottom of the window | your requirement; its state comes from the `mode.status` request, not from reading the bridge's state |
| no context percentage in the topic | no ready-made share of the context window is available to the plugin, and it does not invent its own count: the topic's pinned line carries only the topic name |

The plugin reports turn boundaries itself: a session execution started is `POST /turn/start`, and
finished by success, failure, interruption or idleness is `POST /turn/end`. Turns are named by a
counter of the connection, because the server names no turn id in its events; the counter starts
again with the connection, and the service forgets the names at the same points.

The chat's name is `POST /name {name}`, sent when the connection opens and again on `session.renamed`:
the title is read from the session record the client gives the plugin, and the rename event is the
client's own, so no transcript is read and no polling is done. The name means nothing to the service
beyond "a name you did not type yourself".

A finished agent reply is `POST /message` with its whole text, and the service sends it to the topic
as one message. The server announces the end of a text block itself (`session.text.ended`), so the
plugin neither collects pieces nor guesses the end. Reasoning (`session.reasoning.*`), tool calls
and their input (`session.tool.*`) and steps (`session.step.*`) never reach the topic by the kind of
event alone.

The plugin holds root sessions of its own directory; child agent sessions take no session role, and
another directory is another plugin instance. Every "this session is not held" decision goes to the
server's error stream with its reason, and a session move (`session.moved`) lifts it.

The freshness threshold is one, `DM_TELEGRAM_OPENCODE_REVIVE_HOURS` (12 hours by default), and it
works both ways: sessions touched more recently are revived at start, and at the connection limit
`DM_TELEGRAM_OPENCODE_LINKS` (16 by default) the connection of the session untouched the longest is
dropped. A live session's channel is never taken away by the limit: when every held session is
fresher than the threshold, a new session gets no channel, and it is told so in the session itself.

A connection that ended by itself (the service refused a foreign contract version, another
connection displaced it, the binary is not on `PATH`, no settings are named) is taken off the books,
and the next attempt waits `DM_TELEGRAM_OPENCODE_PAUSE_SECONDS` (30 seconds by default).

## Development

```bash
npm run typecheck      # types; installs dependencies first when node_modules is missing or stale
npm test               # types, then the tests
```

Dependencies are installed by `scripts/deps.ts` from the fingerprint of `package.json` and
`package-lock.json`, under a lock on the directory, so a clean clone needs nothing by hand but the
network for the first run. `node_modules` is not in git; the lock file is.

The plugin brings one dependency: the `@opencode/plugin` SDK, pinned to an exact version. The TUI
reactivity packages (`@opentui/*`, `solid-js`) and `effect` are optional peer dependencies, as in the
SDK itself: a copy of the reactivity runtime in the plugin's `node_modules` would mean a second
runtime in one process.

Code comments and test names are in Russian.

## Windows

The plugin works on Windows through the service's named pipe; the POSIX-only tests (a fake bridge
binary and `SIGTERM`) are skipped there.
