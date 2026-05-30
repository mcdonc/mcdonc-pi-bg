# mcdonc-pi-bg — Background Jobs for Pi

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that enables backgrounding tasks, with job management, real-time output tailing, and keyboard shortcuts.

When you press `ctrl+b` during a running bash command, the command is detached (not killed and restarted) and continues running in the background. The pi main loop is freed for new prompts.

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
| `ctrl+b` | Background the currently executing bash command; if nothing is executing, show the job selector |
| `ctrl+f` | Cycle: off → compact tail widget → full-page scrolling follow → off |
| `alt+f` | Full-page scrolling follow for the most recent job directly |
| `ctrl+j` | Toggle the interactive job selector |
| `` ctrl+` `` | Show tail of the most recent job in chat |

### Commands

| Command | Description |
|---------|-------------|
| `/bg [extra]` | Background the current bash command (same as `ctrl+b`) |
| `/job` | Interactive job picker (up/down to navigate, `x` to kill, `ctrl+f` to follow) |
| `/job ls` | Static job list |
| `/job follow [id\|#]` | Toggle compact live-tailing widget below the editor. Defaults to most recent job. |
| `/job fullfollow [id\|#]` | Full-page scrolling follow overlay. Alias: `ff`. Defaults to most recent job. |
| `/job tail [id\|#]` | Snapshot of the last ~40 KB of output printed into chat |
| `/job kill [id\|#]` | Kill a running job (SIGTERM, then SIGKILL after 500ms) |
| `/job trim [N]` | Keep only N most recent finished jobs (default 5) |
| `/job gc` | Delete orphaned files from state dir |

Numeric indices (`1`, `2`, ...) match the order shown in `/job ls`.

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

Every bash command pi executes is wrapped via a `spawnHook` through `wrapper.ts`. The wrapper:

1. Runs the actual command under `setsid` (new process session/group) with stdout/stderr redirected to a `.out` file
2. Tails the output file and forwards to pi's stdout so pi sees output normally
3. Listens on a FIFO (named pipe) for a "detach" message
4. On detach: wrapper exits cleanly, inner command keeps running and writing to the file
5. On normal exit: wrapper cleans up all temp files and propagates the exit code
6. On abort (no detach): inner command is orphaned; the extension kills it

When `ctrl+b` is pressed, the extension writes "detach" to the control pipe, then calls `ctx.abort()` to free pi's main loop. The surviving process is adopted as a background job and monitored via polling.

## State

Jobs are tracked as custom session entries (survive `/reload`). Process liveness is re-checked on `session_start`.

File artifacts in `~/.pi/agent/state/background/`:
- `bg-ctrl-<unique>.out` — the command's stdout+stderr (what follow widgets tail); cleaned up on normal exit, kept on detach
- `bg-ctrl-<unique>.pid` — PID of the inner process (cleaned up on exit)
- `bg-ctrl-<unique>.pipe` — control FIFO for detach signaling (cleaned up on exit)

## Known issues / limitations

- `ctrl+b` conflicts with cursor-left in some terminals (pi's built-in binding is overridden by the extension).
- `ctrl+f` conflicts with cursor-right (same).
- `alt+f` conflicts with cursor-word-right (same).
- Exit codes are not available for backgrounded jobs (the wrapper has already exited; `isPidAlive` polling can only detect alive/dead).
- The follow widget uses `fs.watch` + 500ms polling fallback for real-time updates.
