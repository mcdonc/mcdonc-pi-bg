# TODO

## improve-job-follow ✓

Cause `job follow` to create a UI control that shows `tail -f`-like output of a
subagent's current task, does not obscure the entire screen, allows its own
scrollback, and isn't foiled by buffering.

Done: `/job follow` now uses `setWidget("bg-follow", ..., { placement: "belowEditor" })`
instead of a full-screen overlay. Chat remains fully usable. `ctrl+f` toggles the
widget. `fs.watch` + 500ms polling fallback avoids buffering issues.
