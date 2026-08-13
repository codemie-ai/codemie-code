# Claude Desktop Telemetry

- Config root — macOS: `~/Library/Application Support/Claude-3p/`
- Config root — Windows: `%LOCALAPPDATA%\Claude-3p\`
- Config root — Linux: `$XDG_CONFIG_HOME/Claude-3p/`, else `~/.config/Claude-3p/`
- Session metadata: `local-agent-mode-sessions/.../local_<session>.json`
- Transcript: `local-agent-mode-sessions/.../local_<session>/audit.jsonl`
- Agent session id: prefer `cliSessionId`, fall back to `sessionId`
- CodeMie client identity: `claude-desktop`
