# Analytics System Development Guide

This guide provides comprehensive documentation for the analytics system in the CodeMie CLI.

**Context**: This file is loaded automatically when working in `src/analytics/**`. It contains guidance for analytics development, aggregation patterns, and CLI usage.

---

## Overview

The Analytics System provides **aggregated metrics and insights** from AI coding sessions:
- JSONL metrics file parsing and aggregation
- Hierarchical data structure (Root → Projects → Branches → Sessions)
- Token breakdown and cost estimation
- Tool usage statistics
- Language/format breakdown
- Multiple export formats (JSON, CSV)

---

## Architecture

### Data Flow

1. **Agents write JSONL metrics** to `~/.codemie/metrics/{sessionId}/session_metrics.jsonl`
2. **Record types**: `session_start`, `turn`, `tool_call`, `session_end`
3. **Aggregator reads and parses** JSONL files on demand
4. **CLI displays** aggregated metrics with filtering and export options

### Hierarchical Structure

```
Root (All Sessions)
├── Projects
│   └── Branches
│       └── Sessions
```

### Core Components

#### Aggregation (`aggregation/`)

- **Root Aggregator**: Parses all session files and builds hierarchy
- **Token Breakdown**: Input, output, cache read, cache creation
- **Cost Estimation**: Model-specific pricing (configurable)
- **Tool Statistics**: Calls, success/failure rates
- **Language Breakdown**: Files created/modified, lines added

#### Project Mapping (`aggregation/core/project-mapping.ts`)

Maps agent-specific project IDs to filesystem paths:
- Stored in `~/.codemie/gemini-project-mappings.json` (per agent)
- Use `registerCurrentProject(agentName, path)` in agent lifecycle hooks
- Enables analytics to resolve project hashes to actual paths

#### Export (`exporters/`)

- **JSON Export**: Full hierarchical structure with nested projects/branches/sessions
- **CSV Export**: Flat session-level data for spreadsheet analysis

---

## Development Patterns

### Pattern 1: Project Mapping Registration

When developing agents that use hashed/obfuscated project IDs:

```typescript
import { registerCurrentProject } from '../../analytics/aggregation/core/project-mapping.js';

// In agent lifecycle hook
lifecycle: {
  beforeRun: async (env) => {
    // Register current working directory for project mapping
    // Creates/updates ~/.codemie/{agent}-project-mappings.json
    registerCurrentProject('gemini', process.cwd());

    return env;
  }
}
```

### Pattern 2: SSO Metrics Sync (Enterprise)

When developing enterprise providers that need to sync metrics:

```typescript
import { aggregateMetrics } from '../../analytics/aggregation/index.js';

agentHooks: {
  '*': {
    onSessionEnd: async (exitCode, env) => {
      const sessionId = env.SESSION_ID;

      // Aggregate session metrics
      const metrics = await aggregateMetrics({
        session: sessionId
      });

      // Send to enterprise backend
      await fetch(`${baseUrl}/v1/metrics/sync`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId,
          metrics: metrics.projects[0]?.branches[0]?.sessions[0]
        })
      });
    }
  }
}
```

### Pattern 3: Custom Aggregation

When implementing custom aggregation logic:

```typescript
import { parseSessionFile } from './aggregation/core/parsers.js';
import { aggregateTokens, aggregateTools } from './aggregation/core/aggregators.js';

export async function customAggregation(sessionId: string) {
  const sessionFile = `~/.codemie/metrics/${sessionId}/session_metrics.jsonl`;
  const records = await parseSessionFile(sessionFile);

  // Filter specific record types
  const turns = records.filter(r => r.type === 'turn');
  const toolCalls = records.filter(r => r.type === 'tool_call');

  // Aggregate tokens
  const tokens = aggregateTokens(turns);

  // Aggregate tools
  const tools = aggregateTools(toolCalls);

  return { tokens, tools };
}
```

---

## CLI Usage Reference

### Quick Start

```bash
# Show all analytics
codemie analytics

# Filter by project
codemie analytics --project codemie-code

# Filter by agent
codemie analytics --agent claude

# Detailed session breakdown
codemie analytics --verbose

# Export to JSON
codemie analytics --export json

# Export to CSV
codemie analytics --export csv -o ./my-analytics.csv
```

### Filtering Options

| Option | Description | Example |
|--------|-------------|---------|
| `--session <id>` | Filter by session ID | `--session abc-123-def-456` |
| `--project <pattern>` | Filter by project path | `--project codemie-code` |
| `--agent <name>` | Filter by agent name | `--agent claude` |
| `--branch <name>` | Filter by git branch | `--branch main` |
| `--from <date>` | Sessions from date (YYYY-MM-DD) | `--from 2025-12-01` |
| `--to <date>` | Sessions to date (YYYY-MM-DD) | `--to 2025-12-10` |
| `--last <duration>` | Sessions from last duration | `--last 7d` |

### Output Options

| Option | Description | Example |
|--------|-------------|---------|
| `-v, --verbose` | Show detailed session-level breakdown | `--verbose` |
| `--export <format>` | Export to file (json or csv) | `--export json` |
| `-o, --output <path>` | Output file path | `-o ./analytics.json` |

### Project Pattern Matching

The `--project` filter supports multiple matching strategies:

1. **Basename match**: `codemie-code` matches `/path/to/codemie-code`
2. **Partial path**: `codemie-ai/codemie-code` matches full path
3. **Full path**: `/Users/name/repos/project` matches exactly
4. **Case-insensitive** matching

### Duration Format

The `--last` option accepts duration strings:
- `7d` - Last 7 days
- `24h` - Last 24 hours
- `30m` - Last 30 minutes

---

## Metrics Displayed

### Root Level (All Sessions)

- Total Sessions
- Total Duration
- Total Turns
- Total Tokens (input + output + cache)
- Total Cost (estimated in USD)
- Cache Hit Rate (verbose mode)

### Model Distribution

- Model name
- Number of calls
- Share percentage

### Tool Usage

- Tool name (Read, Write, Edit, Bash, etc.)
- Total calls
- Success count
- Failure count
- Success rate percentage

### Language/Format Breakdown

- Language/Format name
- Files created
- Files modified
- Lines added
- Share percentage
- Token attribution (verbose mode)

### Session Details (Verbose Mode)

- Session ID
- Agent name
- Provider
- Duration
- Token breakdown (input, cache creation, cache read, output)
- Cache hit rate
- Models used
- Tools used
- Files changed
- Language statistics

---

## Export Formats

### JSON Export

Full hierarchical structure with all metrics:

```json
{
  "projects": [
    {
      "projectPath": "/path/to/project",
      "branches": [
        {
          "branchName": "main",
          "sessions": [...]
        }
      ],
      "totalSessions": 5,
      "totalTokens": {...}
    }
  ],
  "totalSessions": 10,
  "models": [...],
  "tools": [...]
}
```

### CSV Export

Flat session-level data suitable for spreadsheets:

| Session ID | Agent | Provider | Project | Branch | Start Time | Duration | Turns | Tokens | Cost | Model | Files | Lines |
|------------|-------|----------|---------|--------|------------|----------|-------|--------|------|-------|-------|-------|

---

## Example Workflows

### 1. Weekly Summary

```bash
codemie analytics --last 7d
```

### 2. Project-Specific Analysis

```bash
codemie analytics --project my-project --verbose
```

### 3. Agent Comparison

```bash
codemie analytics --agent claude
codemie analytics --agent gemini
```

### 4. Export for Reporting

```bash
codemie analytics --from 2025-12-01 --to 2025-12-07 --export csv -o weekly-report.csv
```

### 5. Branch-Specific Metrics

```bash
codemie analytics --project my-project --branch feature/analytics
```

### 6. Cost Tracking

```bash
codemie analytics --last 30d --export json -o monthly-costs.json
```

---

## Data Requirements

The analytics command requires:

1. **JSONL Metrics Files**: `~/.codemie/metrics/{sessionId}/session_metrics.jsonl`
2. **Record Types**: session_start, turn, tool_call, session_end
3. **Minimum Data**: At least one complete session with start/end records

---

## Troubleshooting

### No Sessions Found

**Problem**: "No sessions found matching the specified criteria"

**Solutions**:
- Verify metrics directory exists: `ls ~/.codemie/metrics/`
- Check for JSONL files: `ls ~/.codemie/metrics/*/session_metrics.jsonl`
- Ensure metrics collection is enabled for your provider
- Try without filters: `codemie analytics`

### No Analytics Data

**Problem**: "No analytics data available"

**Solutions**:
- Check that session files contain turn/tool records
- Verify JSONL format is valid: `cat ~/.codemie/metrics/{id}/session_metrics.jsonl | jq`
- Run a test session to generate fresh metrics

### Export Fails

**Problem**: Export command fails or creates empty files

**Solutions**:
- Check write permissions in output directory
- Verify sufficient disk space
- Use absolute path for output: `-o /full/path/to/file.json`

---

## Integration with Agents

The analytics command works with data generated by:
- `codemie-claude` - Claude Code agent sessions
- `codemie-gemini` - Gemini CLI agent sessions
- `codemie-codex` - Codex agent sessions
- Any agent that implements the metrics JSONL format

---

## Best Practices

1. **Regular Exports**: Export analytics weekly for trend analysis
2. **Cost Tracking**: Use `--last 30d` to monitor monthly costs
3. **Project Isolation**: Filter by project for accurate per-project metrics
4. **Verbose Mode**: Use for debugging or detailed investigation
5. **CSV for Reporting**: Use CSV export for integration with BI tools

---

## Testing

### Unit Testing

Test aggregation logic:

```typescript
import { describe, it, expect } from 'vitest';
import { aggregateTokens } from './aggregation/core/aggregators.js';

describe('Token Aggregation', () => {
  it('should sum input tokens', () => {
    const turns = [
      { type: 'turn', usage: { input_tokens: 100 } },
      { type: 'turn', usage: { input_tokens: 50 } }
    ];

    const result = aggregateTokens(turns);
    expect(result.input).toBe(150);
  });
});
```

### Integration Testing

Test CLI command:

```typescript
import { describe, it, expect } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('analytics command', () => {
  it('should show analytics summary', async () => {
    const { stdout } = await execAsync('codemie analytics');
    expect(stdout).toContain('Total Sessions');
  });

  it('should filter by project', async () => {
    const { stdout } = await execAsync('codemie analytics --project test');
    expect(stdout).toContain('PROJECT:');
  });
});
```

---

## Architecture Benefits

✅ **On-Demand Parsing**: Only reads JSONL files when needed
✅ **Hierarchical Structure**: Natural project/branch/session organization
✅ **Flexible Filtering**: Multiple filter dimensions (project, agent, date, etc.)
✅ **Multiple Export Formats**: JSON for processing, CSV for spreadsheets
✅ **Extensible**: Easy to add new metrics or aggregation logic
✅ **Type-Safe**: Full TypeScript support with proper interfaces
