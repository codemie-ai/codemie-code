# Files

- [Agent Adapters, Installation, and Runtime Injection](agent-plugin-system.md) - How CodeMie represents coding agents as registry-backed adapters, manages their installation and launch lifecycle, and injects runtime plugins into the built-in CodeMie Code runtime.
- [MCP Relay and Desktop/Editor Proxy Clients](mcp-and-desktop-clients.md) - How CodeMie bridges stdio MCP clients to remote streamable HTTP servers with per-session OAuth and cookies, and configures Claude Desktop, VS Code, and Codex Desktop to use its managed local proxy.
- [Provider Plugins, SSO, and the Streaming Local Proxy](provider-plugins-and-local-proxy.md) - How provider plugins register capabilities and setup behavior, and how SSO or JWT-authenticated agent traffic passes through the ordered, streaming local proxy.
