# dsh-herdr

**English** · [中文](./README.zh.md)

Herdr status integration for DeepSeek Harness. The plugin runs inside the DSH TUI process and rolls the root agent and its child agents up into one semantic status for the Herdr pane that owns the process.

## Status mapping

| DSH process state | Herdr status |
| --- | --- |
| Any agent has an unresolved approval | `blocked` |
| No pending approval, any agent running | `working` |
| Agents exist and all are idle | `idle` |
| No agents yet, or the last one disposed | `idle` |
| The plugin unloaded | `release-agent` |

The plugin claims its pane the moment it loads, before the first agent exists, so an open-but-unused DSH TUI still appears in the Herdr agent panel. Authority is only handed back when the plugin unloads — an empty rollup is `idle`, not a release, because the TUI still owns the pane.

Every report carries the root DSH session id as Herdr's `agent_session_id`, which is the key `DSH_TUI_RESUME_SESSION` accepts. The root is the first top-level agent from `ctx.agents.roots()`; Herdr hands the value back through its pane and agent APIs as `agent_session` with `kind: "id"`.

The plugin listens on `agent/created`, `agent/status`, `agent/disposed`, and `session/event`. When an existing session is resumed it folds the `approval/asked` and `approval/decided` events already in the log, so a pending approval survives a restart instead of being lost.

## Requirements

- DeepSeek Harness `0.1.2-rc.1`
- Node.js `22.19+` or `24+`
- A Herdr-managed pane (the process environment carries `HERDR_ENV=1` and `HERDR_PANE_ID`)

The plugin prefers a persistent NDJSON connection over `HERDR_SOCKET_PATH` — a Unix domain socket on macOS and Linux, a named pipe on Windows. If the connection, a timeout, or the protocol fails, that one report falls back to the Herdr CLI named by `HERDR_BIN_PATH`, and the next status change retries the socket. Outside a Herdr pane the plugin disables itself and leaves DSH untouched.

## Build and install locally

```sh
pnpm install
pnpm run check
pnpm pack --ignore-scripts
dsh plugin --profile tui add ./lbryany-dsh-herdr-0.1.3.tgz
dsh --profile tui
```

Replace `tui` with your own profile name if it differs.

To develop against a checkout instead of a tarball, link it into the profile — the profile then always loads your latest `pnpm run build` output:

```sh
dsh plugin --profile tui add link:/path/to/dsh-herdr
```

## Install from a release

This fork publishes tagged releases. Install a pinned one:

```sh
dsh plugin --profile tui add 'github:nmindz/dsh-herdr#v0.1.3'
```

Quote the spec. In zsh with `extendedglob` enabled — the default in many setups — an unquoted `#` is a glob operator and the shell fails with `no matches found` before `dsh` ever runs.

Omit the tag to track the default branch instead:

```sh
dsh plugin --profile tui add github:nmindz/dsh-herdr
```

## Verify

Start the DSH TUI inside a Herdr pane, then inspect it from another pane:

```sh
herdr agent list
```

It should read `working` while DSH is processing a message, `blocked` while it waits on a tool approval, and `idle` when it finishes — or `done`, if Herdr derives that from pane visibility.

## Design notes

- Status reports run serially through an in-process queue and carry a `seq` in epoch microseconds, which increases across processes. Restarting DSH in the same pane therefore does not restart the count at `1`, and Herdr does not mistake a fresh report for a stale one.
- One DSH process reuses a single socket connection rather than spawning a Herdr child process per status change.
- Socket requests time out after 3 seconds by default. A failure falls back to the CLI, and only when both paths fail is a warning logged — a reporting failure never blocks a DSH agent.
- Each DSH TUI process inherits its own `HERDR_PANE_ID`, so no cross-process coordination is needed.

## License

[MIT](./LICENSE)
