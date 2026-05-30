# TODO

## full-page-follow ✓

Provide full-page scrolling follow output if ctrl-shift-F is pressed (as opposed
to the compact below-editor widget that ctrl+f toggles).

Done: `alt+f` opens a full-page overlay via `ctx.ui.custom()` with scrolling
(up/down/PgUp/PgDn/Home/End). Auto-follows new output unless the user scrolls up.
Also available as `/job fullfollow` or `/job ff`.
