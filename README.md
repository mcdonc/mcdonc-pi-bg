# mcdonc-pi-bg — Background Jobs for Pi

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that enables backgrounding tasks (like claude-code's ctrl-b), with job management, real-time output tailing, and keyboard shortcuts.

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

> **Note**: `index.ts` imports `./lib.ts`, so copying `index.ts` alone is not sufficient.

## State

Jobs are tracked as custom session entries (survive `/reload`). Process liveness is re-checked on `session_start`.

File artifacts in `~/.pi/agent/state/background/`:
- `bg-ctrl-<unique>.out` — the command's stdout+stderr (what `/job follow` / `/job tail` reads)
- `bg-ctrl-<unique>.pid` — PID of the inner process (cleaned up on exit)
- `bg-ctrl-<unique>.pipe` — control FIFO for detach signaling (cleaned up on exit)

## Usage

### Keyboard shortcut

| Key | Action |
|-----|--------|
| `ctrl+b` | Background the currently executing bash command; if nothing is executing, show the job selector |
| `ctrl+f` | Toggle the live tail widget for the most recent job (open if closed, close if open) |
| `alt+f` | Full-page scrolling follow for the most recent job (up/down/PgUp/PgDn/Home/End to scroll, auto-follows new output) |

### Commands

| Command | Description |
|---------|-------------|
| `/job` | Interactive job picker (up/down to select, Enter to follow) |
| `/job ls` | Static job list |
| `/job follow [id\|#]` | Toggle live-tailing widget below the editor (non-blocking, chat remains usable). Defaults to most recent job. |
| `/job fullfollow [id\|#]` | Full-page scrolling follow overlay with scroll controls. Alias: `ff`. Defaults to most recent job. |
| `/job tail [id\|#]` | Snapshot of the last ~40 KB of output printed into chat |
| `/job attach [id\|#]` | Attach to the job's pi session file (replaces current session) — only available if the job was spawned as a full pi subprocess |
| `/job kill [id\|#]` | Kill a running job |
| `/job trim [N]` | Keep only N most recent finished jobs (default 5) |
| `/job gc` | Delete orphaned files from state dir |

Numeric indices (`#1`, `#2`, …) match the order shown in `/job ls`.

## Behaviour

- **Process wrapping**: Every bash command is wrapped via `spawnHook` with `wrapper.ts`, which runs the command under `setsid`. This creates a new process group so the inner command survives when pi aborts its own process tree. On `ctrl+b` / `/bg`, a detach signal is sent over a control pipe; the wrapper exits while the inner process keeps running.
- **`currentBashCtrl` tracking**: The extension tracks the active wrapped bash invocation so `ctrl+b` backgrounds the actual running command, not the conversational user message.
- **Auto-trim**: The job list is automatically trimmed to the 5 most recent finished jobs on every listing and every new `/bg` spawn (`AUTO_TRIM_KEEP = 5` at top of file).
- **Exit notifications**: When a job exits, you get an info/warning/error notification based on exit code / signal.
- **Footer widget**: Shows `bg:N` while N jobs are running.

## Known issues / limitations

- The follow widget uses `fs.watch` for real-time updates (event-driven, no buffering lag), with a 500ms polling fallback for filesystems where `fs.watch` is unreliable.
- The widget appears below the editor (above the status bar) so the chat remains fully visible and interactive.
- Close with `ctrl+f` or by running `/job follow <id>` again on the same job (toggle).
- `ctrl+b` conflicts with cursor-left in some terminals.
