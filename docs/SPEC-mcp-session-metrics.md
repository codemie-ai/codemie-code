# Specification: MCP Server Detection for Session Metrics

**Status:** Draft
**Created:** 2026-01-23
**Ticket:** EPMCDME-10048

---

## Overview

Enhance session start and session end metrics with MCP (Model Context Protocol) server configuration detection. The goal is to capture what MCP servers are configured at different scopes to understand MCP adoption and usage patterns across sessions.

---

## Background

### MCP Configuration Scopes

Claude Code supports three MCP installation scopes:

| Scope | Location | Description |
|-------|----------|-------------|
| **Local** | `.claude.json` in project directory | Private to user, only in current project |
| **Project** | `.mcp.json` at project root | Shared with team (version controlled) |
| **User** | `~/.claude.json` in home directory | Available across all projects |

### Configuration File Format

```json
{
  "mcpServers": {
    "server-name": {
      "type": "http|stdio|sse",
      "url": "https://api.example.com/mcp",
      "command": "/path/to/server",
      "args": ["--config", "config.json"],
      "env": { "API_KEY": "value" }
    }
  }
}
```

---

## Metrics Specification

### New Session Attributes

| Field | Type | Description |
|-------|------|-------------|
| `mcp_total_servers` | number | Total count across all scopes |
| `mcp_local_servers` | number | Count in local scope |
| `mcp_project_servers` | number | Count in project scope |
| `mcp_user_servers` | number | Count in user scope |
| `mcp_server_names` | string[] | All server names (unique) |
| `mcp_local_server_names` | string[] | Server names in local scope |
| `mcp_project_server_names` | string[] | Server names in project scope |
| `mcp_user_server_names` | string[] | Server names in user scope |

### Session Start Metrics Payload

```json
{
  "name": "codemie_cli_session_total",
  "attributes": {
    "agent": "claude",
    "agent_version": "0.0.31",
    "llm_model": "claude-sonnet-4-20250514",
    "repository": "codemie-ai/codemie-code",
    "session_id": "abc-123-uuid",
    "branch": "main",
    "project": "my-sso-project",

    "mcp_total_servers": 5,
    "mcp_local_servers": 1,
    "mcp_project_servers": 2,
    "mcp_user_servers": 2,

    "mcp_server_names": ["github", "notion", "slack", "filesystem", "postgres"],
    "mcp_local_server_names": ["postgres"],
    "mcp_project_server_names": ["github", "notion"],
    "mcp_user_server_names": ["slack", "filesystem"],

    "total_user_prompts": 0,
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "total_cache_read_input_tokens": 0,
    "total_cache_creation_tokens": 0,
    "total_tool_calls": 0,
    "successful_tool_calls": 0,
    "failed_tool_calls": 0,
    "files_created": 0,
    "files_modified": 0,
    "files_deleted": 0,
    "total_lines_added": 0,
    "total_lines_removed": 0,

    "session_duration_ms": 0,
    "had_errors": false,
    "count": 1,
    "status": "started",
    "reason": "startup"
  }
}
```

### Session End Metrics Payload

```json
{
  "name": "codemie_cli_session_total",
  "attributes": {
    "agent": "claude",
    "agent_version": "0.0.31",
    "llm_model": "claude-sonnet-4-20250514",
    "repository": "codemie-ai/codemie-code",
    "session_id": "abc-123-uuid",
    "branch": "main",
    "project": "my-sso-project",

    "mcp_total_servers": 5,
    "mcp_local_servers": 1,
    "mcp_project_servers": 2,
    "mcp_user_servers": 2,

    "mcp_server_names": ["github", "notion", "slack", "filesystem", "postgres"],
    "mcp_local_server_names": ["postgres"],
    "mcp_project_server_names": ["github", "notion"],
    "mcp_user_server_names": ["slack", "filesystem"],

    "total_user_prompts": 0,
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "total_cache_read_input_tokens": 0,
    "total_cache_creation_tokens": 0,
    "total_tool_calls": 0,
    "successful_tool_calls": 0,
    "failed_tool_calls": 0,
    "files_created": 0,
    "files_modified": 0,
    "files_deleted": 0,
    "total_lines_added": 0,
    "total_lines_removed": 0,

    "session_duration_ms": 125000,
    "had_errors": false,
    "count": 1,
    "status": "completed",
    "reason": "prompt_input_exit"
  }
}
```

---

## TypeScript Type Definition

Add to `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts`:

```typescript
export interface SessionAttributes {
  // ...existing fields...

  // MCP Configuration - Counts
  mcp_total_servers?: number;
  mcp_local_servers?: number;
  mcp_project_servers?: number;
  mcp_user_servers?: number;

  // MCP Configuration - Server Names
  mcp_server_names?: string[];
  mcp_local_server_names?: string[];
  mcp_project_server_names?: string[];
  mcp_user_server_names?: string[];
}
```

---

## Implementation Plan

### 1. New Utility Module: `src/utils/mcp-config.ts`

**Purpose:** Read and parse MCP configuration files from all scopes

**Functions:**
- `getMCPConfigPaths(cwd: string)` - Returns config file paths for given working directory
- `readMCPConfig(filePath: string)` - Safely read and parse single config file
- `detectMCPServers(cwd: string)` - Detect all MCP servers across scopes
- `getMCPConfigSummary(cwd: string)` - Returns summary for metrics

**MCP Config Summary Type:**
```typescript
interface MCPConfigSummary {
  totalServers: number;
  localServers: number;
  projectServers: number;
  userServers: number;
  serverNames: string[];
  localServerNames: string[];
  projectServerNames: string[];
  userServerNames: string[];
}
```

### 2. Modify Session Start Flow

**File:** `src/cli/commands/hook.ts`

**Changes to `sendSessionStartMetrics()`:**
1. Call `getMCPConfigSummary(workingDirectory)`
2. Add MCP attributes to the metrics payload

### 3. Modify Session End Flow

**File:** `src/cli/commands/hook.ts`

**Changes to `sendSessionEndMetrics()`:**
1. Re-detect MCP config (may have changed during session)
2. Add MCP attributes to the metrics payload

### 4. Update Metrics Types

**File:** `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts`

Add MCP fields to `SessionAttributes` interface.

---

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/utils/mcp-config.ts` | **NEW** | MCP config detection utilities |
| `src/cli/commands/hook.ts` | MODIFY | Add MCP detection to session start/end |
| `src/providers/plugins/sso/session/processors/metrics/metrics-types.ts` | MODIFY | Add MCP attributes to SessionAttributes |

---

## Security Considerations

| Concern | Mitigation |
|---------|------------|
| Don't expose URLs | Only capture server names, not URLs |
| Don't expose tokens/secrets | Never read env values, headers, credentials |
| Don't expose commands | Only capture server names, not command paths |

---

## Kibana Dashboard Use Cases

| Visualization | Query/Aggregation |
|---------------|-------------------|
| **Sessions with MCP enabled** | Filter: `mcp_total_servers > 0` |
| **Top 10 MCP servers** | Terms aggregation on `mcp_server_names` |
| **Sessions using "github" MCP** | Filter: `mcp_server_names: "github"` |
| **MCP adoption over time** | Date histogram + avg(`mcp_total_servers`) |
| **Project vs User scope usage** | Compare sum(`mcp_project_servers`) vs sum(`mcp_user_servers`) |
| **MCP diversity per repository** | Group by `repository`, cardinality of `mcp_server_names` |

---

## Elasticsearch Mapping

Array fields should use keyword type:

```json
{
  "mcp_server_names": { "type": "keyword" },
  "mcp_local_server_names": { "type": "keyword" },
  "mcp_project_server_names": { "type": "keyword" },
  "mcp_user_server_names": { "type": "keyword" }
}
```

---

## Notes

- All MCP fields are optional for backward compatibility
- Default to 0/empty array when MCP detection fails (don't block session)
- Re-detect at session end since MCP config may change during session
- Only enabled for `ai-run-sso` provider (same as existing metrics)
