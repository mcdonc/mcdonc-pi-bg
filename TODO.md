# TODO

## Claude Code background agent feature

Claude Code has a "run in background" feature (ctrl+b) that pushes a long-running
agent task to a background agent. This is similar to but distinct from what we do
here — Claude Code backgrounds the entire agent turn (including LLM calls), not
just a bash process. Worth investigating whether their approach could inform the
fork/resume feature, and whether there's overlap or integration opportunity.

## replace bash tool entirely

Consider using `registerTool` to replace the built-in bash tool entirely instead
of using spawnHook. This would give full control over abort behavior (could
detach from the process without killing it) and control over what gets reported
back to the LLM. Downside: would need to reimplement output accumulation,
truncation, streaming updates, and render functions (~160 lines of UI code).
