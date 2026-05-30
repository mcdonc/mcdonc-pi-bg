# pi background jobs extension

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that enables backgrounding tasks (like claude-code's ctrl-b), with job management, real-time output tailing, and keyboard shortcuts.

## Install

```sh
mkdir -p ~/.pi/agent/extensions/background
cp index.ts ~/.pi/agent/extensions/background/index.ts
```

Then add to `~/.pi/agent/settings.json`:
```json
{
  "extensions": ["~/.pi/agent/extensions/background/index.ts"]
}
```

Then `/reload` inside pi.

## State

Jobs are stored in `~/.pi/agent/state/background/`:
- `bg-<id>.jsonl` — child pi session file
- `bg-<id>.log` — child pi stdout/stderr (pi's own output, not the command's)
- `bg-<id>.out` — the command's output (what `/job follow` tails)

Session files are kept out of `~/.pi/agent/sessions/` so they don't pollute `/resume`.

## Usage

### Keyboard shortcut

| Key | Action |
|-----|--------|
| `ctrl+b` | Background the last bash command (or last prompt if no bash command ran) |
| `ctrl+f` | Toggle the live tail widget for the most recent job (open if closed, close if open) |

### Commands

| Command | Description |
|---------|-------------|
| `/job` | Interactive job picker (up/down to select, Enter to follow) |
| `/job ls` | Static job list |
| `/job follow [id\|#]` | Toggle live-tailing widget below the editor (non-blocking, chat remains usable). Defaults to most recent job. |
| `/job tail [id\|#]` | Snapshot of last 50 lines printed into chat |
| `/job attach [id\|#]` | Attach to the child pi session (replaces current session) |
| `/job kill [id\|#]` | Kill a running job |
| `/job trim [N]` | Keep only N most recent finished jobs (default 5) |
| `/job gc` | Delete orphaned files from state dir |

Numeric indices (`#1`, `#2`, …) match the order shown in `/job ls`.

## Behaviour

- **Child prompt**: The child pi session receives a direct imperative system instruction telling it to immediately execute the last bash command and redirect long-running output to `bg-<id>.out`.
- **`lastBashCommand` tracking**: The extension tracks the most recent bash tool execution so `ctrl+b` backgrounds the actual command, not the conversational user message.
- **Auto-trim**: The job list is automatically trimmed to the 5 most recent finished jobs on every listing and every new `/bg` spawn (`AUTO_TRIM_KEEP = 5` at top of file).
- **Exit notifications**: When a job exits, you get an info/warning/error notification based on exit code / signal.
- **Footer widget**: Shows `bg:N` while N jobs are running.

## Known issues / limitations

- The follow widget uses `fs.watch` for real-time updates (event-driven, no buffering lag), with a 500ms polling fallback for filesystems where `fs.watch` is unreliable.
- The widget appears below the editor (above the status bar) so the chat remains fully visible and interactive.
- Close with `ctrl+f` or by running `/job follow <id>` again on the same job (toggle).
- `ctrl+b` conflicts with cursor-left in some terminals.
- Many key combos are eaten by browser/desktop when running pi in a browser-based terminal (xterm.dart in Firefox etc.).
