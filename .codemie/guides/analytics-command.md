# Analytics Command Guide

The `codemie analytics` command provides aggregated metrics and insights from your AI coding sessions.

## Overview

The analytics command reads JSONL metrics files from `~/.codemie/metrics/{sessionId}/session_metrics.jsonl` and aggregates them into a hierarchical view:

```
Root (All Sessions)
├── Projects
│   └── Branches
│       └── Sessions
```

## Quick Start

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

## Command Options

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

## Project Pattern Matching

The `--project` filter supports multiple matching strategies:

1. **Basename match**: `codemie-code` matches `/path/to/codemie-code`
2. **Partial path**: `codemie-ai/codemie-code` matches full path
3. **Full path**: `/Users/name/repos/project` matches exactly
4. **Case-insensitive** matching

## Duration Format

The `--last` option accepts duration strings:

- `7d` - Last 7 days
- `24h` - Last 24 hours
- `30m` - Last 30 minutes

## Metrics Displayed

### Root Level (All Sessions)

- **Total Sessions**: Number of sessions
- **Total Duration**: Cumulative session time
- **Total Turns**: LLM conversation turns
- **Total Tokens**: Input + Output + Cache tokens
- **Total Cost**: Estimated cost in USD
- **Cache Hit Rate**: Cache efficiency (verbose mode)

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

## Output Example

```
============================================================
ANALYTICS SUMMARY
============================================================
Total Sessions: 4
Total Duration: 2m 18s
Total Turns: 18
Total Tokens: 55,227
Total Cost: $0.3286

Models:
  claude-sonnet-4-5-20250929
    Calls: 8
    Share: 44.4%
  claude-opus-4-20250514
    Calls: 6
    Share: 33.3%

Tool Usage:
  Read
    Calls: 4
    Success: 4
    Failure: 0
    Success Rate: 100.0%
  Write
    Calls: 4
    Success: 4
    Failure: 0
    Success Rate: 100.0%

------------------------------------------------------------
PROJECTS
------------------------------------------------------------

============================================================
PROJECT: /Users/developer/repos/codemie-code
============================================================
  Total Sessions: 3
  Total Duration: 1m 47s
  Total Turns: 14
  Total Tokens: 43,339
  Total Cost: $0.2727

  Models:
    claude-sonnet-4-5-20250929
      Calls: 8
      Share: 57.1%

  By Language:
    typescript
      Lines: 147
      Created: 3
      Modified: 2
      Share: 100.0%
```

## Data Requirements

The analytics command requires:

1. **JSONL Metrics Files**: `~/.codemie/metrics/{sessionId}/session_metrics.jsonl`
2. **Record Types**: session_start, turn, tool_call, session_end
3. **Minimum Data**: At least one complete session with start/end records

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

## Integration with Other Commands

The analytics command works with data generated by:

- `codemie-claude` - Claude Code agent sessions
- `codemie-gemini` - Gemini CLI agent sessions
- `codemie-codex` - Codex agent sessions
- Any agent that implements the metrics JSONL format

## Best Practices

1. **Regular Exports**: Export analytics weekly for trend analysis
2. **Cost Tracking**: Use `--last 30d` to monitor monthly costs
3. **Project Isolation**: Filter by project for accurate per-project metrics
4. **Verbose Mode**: Use for debugging or detailed investigation
5. **CSV for Reporting**: Use CSV export for integration with BI tools

## Future Enhancements

Planned features for future versions:

- Dashboard visualization
- Cost estimation improvements
- Real-time analytics streaming
- Cloud sync for multi-machine aggregation
- Custom metric definitions
- Alert thresholds

## Related Documentation

- **Metrics Implementation**: See `.codemie/guides/metrics-implementation-summary.md`
- **Testing Metrics**: See `.codemie/guides/testing-metrics-phase1-2.md`
- **Agent Plugin Development**: See `.codemie/guides/agent-plugin-development.md`
