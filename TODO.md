# TODO

## replace bash tool entirely

Consider using `registerTool` to replace the built-in bash tool entirely instead
of using spawnHook. This would give full control over abort behavior (could
detach from the process without killing it) and control over what gets reported
back to the LLM. Downside: would need to reimplement output accumulation,
truncation, streaming updates, and render functions (~160 lines of UI code).
