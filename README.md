# mcdonc-pi-bg — Background Jobs & Conversation Forking for Pi

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that enables backgrounding bash commands and forking conversations, with job management, real-time output tailing, and keyboard shortcuts.

## Features

- **Background jobs**: Press `ctrl+b` during a running bash command to detach it. The command continues in the background while the pi main loop is freed for new prompts.
- **Conversation forking**: Press `ctrl+b` while the LLM is thinking to start a side conversation on a clean branch. The original task can be resumed later with `/bb`.

## Install

### Via `pi install` (recommended)

```sh
pi install git:github.com/mcdonc/mcdonc-pi-bg
# or: pi install https://github.com/mcdonc/mcdonc-pi-bg
```

Then `/reload` inside pi.

### Manual

Clone or copy the whole directory into your pi packages, then `/reload`:

```sh
git clone https://github.com/mcdonc/mcdonc-pi-bg.git ~/.pi/agent/packages/mcdonc-pi-bg
# or: cp -r mcdonc-pi-bg ~/.pi/agent/packages/mcdonc-pi-bg
```

Then `/reload` inside pi.

> **Note**: The extension requires `index.ts`, `lib.ts`, and `wrapper.ts`. Copying `index.ts` alone is not sufficient.

## Development

Uses [devenv](https://devenv.sh/) for development environment. Run `devenv shell` to enter the environment (installs Node.js and npm dependencies automatically).

```sh
tests        # run the test suite
runpi        # launch pi with the extension loaded
```

## Usage

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `ctrl+b` | If a bash command is executing: background it. If the LLM is active: pre-fill `/b ` to start a side conversation (Escape to cancel). If idle: show the job selector. |
| `ctrl+f` | Cycle: off → compact tail widget → full-page scrolling follow → off |
| `ctrl+j` | Toggle the interactive job selector |

### Background job commands

| Command | Description |
|---------|-------------|
| `/bg [extra]` | Background the current bash command (same as `ctrl+b` during tool execution) |
| `/job` | Interactive job picker (up/down to navigate, `x` to kill, `ctrl+f` to follow) |
| `/job ls` | Static job list |
| `/job follow [id\|#]` | Toggle compact live-tailing widget below the editor. Defaults to most recent job. |
| `/job fullfollow [id\|#]` | Full-page scrolling follow overlay. Alias: `ff`. Defaults to most recent job. |
| `/job tail [id\|#]` | Snapshot of the last ~40 KB of output printed into chat |
| `/job kill [id\|#]` | Kill a running job (SIGTERM, then SIGKILL after 500ms) |
| `/job trim [N]` | Keep only N most recent finished jobs (default 5) |
| `/job gc` | Delete orphaned files from state dir |

Numeric indices (`1`, `2`, ...) match the order shown in `/job ls`.

### Conversation fork commands

| Command | Description |
|---------|-------------|
| `/b` | Fork the conversation — abort the current task and start a clean branch |
| `/b <message>` | Fork and immediately send a message on the new branch |
| `/bb` | Rejoin the most recent forked conversation (the original task continues) |
| `/bbb` | Abandon all forks and resume the earliest (root) task |

## Conversation forking

When the LLM is working on a long task and you think of something else you need to do, press `ctrl+b`. The editor is pre-filled with `/b ` — type your question and hit Enter. The current task is paused and you start a side conversation on a clean branch (the LLM has no knowledge of the paused task).

When you're done with the side conversation, type `/bb` to rejoin the original task. The LLM picks up where it left off.

If you change your mind after pressing `ctrl+b`, just hit Escape — the editor clears and the original task continues uninterrupted.

Forks can nest: you can fork during a fork. `/bb` always rejoins the most recent fork. `/bbb` abandons all forks and goes back to the root task.

The status bar shows `⑂ N fork(s)` when there are active (unrejoined) fork points.

## Job selector

The interactive job selector (`ctrl+j` or `/job`) shows:

```
> abc123   5m ● infdate         run ./infdate.sh
  def456  12m ✓ make            make -j8 all
  ghi789  15m ✗ deploy          sudo ./deploy.sh
```

Status icons: `●` running (yellow), `✓` exited (green), `✗` killed (red), `?` unknown (dim).

Keys: `↑↓` navigate, `x` kill, `ctrl+f` toggle follow, `ctrl+b`/`ctrl+j`/`esc` close.

## How it works

### Background jobs

Every bash command pi executes is wrapped via a `spawnHook` through `wrapper.ts`. The wrapper:

1. Runs the actual command under `setsid` (new process session/group) with stdout/stderr redirected to a `.out` file
2. Tails the output file and forwards to pi's stdout so pi sees output normally
3. Listens on a FIFO (named pipe) for a "detach" message
4. On detach: wrapper exits cleanly, inner command keeps running and writing to the file
5. On normal exit: wrapper cleans up all temp files and propagates the exit code
6. On abort (no detach): inner command is orphaned; the extension kills it

When `ctrl+b` is pressed during a bash command, the extension writes "detach" to the control pipe, then calls `ctx.abort()` to free pi's main loop. The surviving process is adopted as a background job and monitored via polling.

### Conversation forking

Forking uses pi's session tree infrastructure. When `/b` runs:

1. The current turn is aborted (if still running)
2. The extension walks up the session tree to find the user message that started the current task
3. `navigateTree` moves the session to the parent of that message, creating a clean branch point
4. The user's next message becomes a sibling branch — the LLM sees no trace of the paused task

When `/bb` runs, `navigateTree` moves back to the saved fork point's leaf, and a resume prompt tells the LLM to continue the original task.

## State

Jobs are tracked as custom session entries (survive `/reload`). Process liveness is re-checked on `session_start`.

Fork points are also tracked as custom session entries, with the session tree entry ID of the aborted turn's leaf.

File artifacts in `~/.pi/agent/state/background/`:
- `bg-ctrl-<unique>.out` — the command's stdout+stderr (what follow widgets tail); cleaned up on normal exit, kept on detach
- `bg-ctrl-<unique>.pid` — PID of the inner process (cleaned up on exit)
- `bg-ctrl-<unique>.pipe` — control FIFO for detach signaling (cleaned up on exit)

## Known issues / limitations

- `ctrl+b` conflicts with cursor-left in some terminals (pi's built-in binding is overridden by the extension).
- `ctrl+f` conflicts with cursor-right (same).
- Exit codes are not available for backgrounded jobs (the wrapper has already exited; `isPidAlive` polling can only detect alive/dead).
- The follow widget uses `fs.watch` + 500ms polling fallback for real-time updates.
- The "Operation aborted" message shown when forking is hardcoded in pi and cannot be customized by extensions.
