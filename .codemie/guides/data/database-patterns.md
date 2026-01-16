# Database Patterns

## Quick Summary

Data persistence patterns for CodeMie Code: File-based storage, JSONL format, session data, and configuration management.

**Category**: Data
**Complexity**: Simple
**Prerequisites**: File system operations, JSON

---

## Overview

**CodeMie Code does NOT use a traditional database.** Data persistence uses:
1. **JSON files** - Configuration, profiles (`~/.codemie/config.json`)
2. **JSONL files** - Session data, conversation history, metrics
3. **Encrypted files** - Credentials (`~/.codemie/.credentials`)
4. **Log files** - Daily debug logs (`~/.codemie/logs/`)

**No migrations, no ORM, no SQL** - simple file-based storage for CLI tool.

---

## Storage Structure

```
~/.codemie/
├── config.json                Configuration & profiles
├── .credentials               Encrypted credentials (AES-256-GCM)
├── .session-claude/           Claude session data
│   ├── conversations.jsonl    Conversation history
│   └── metrics.jsonl          Usage metrics
├── .session-gemini/           Gemini session data
│   ├── conversations.jsonl
│   └── metrics.jsonl
└── logs/
    └── debug-2026-01-16.log   Daily debug logs
```

**Location**: `~/.codemie` (configurable via `CODEMIE_HOME`)

**Source**: src/utils/paths.ts:getCodemieHome()

---

## Configuration Storage (JSON)

### Pattern: Multi-Profile Config File

```typescript
// Source: src/utils/config.ts (pattern)
interface ConfigFile {
  activeProfile: string;
  profiles: Record<string, ProfileConfig>;
}

interface ProfileConfig {
  provider: string;      // 'openai', 'anthropic', 'sso', etc.
  model: string;
  authToken?: string;
  baseUrl?: string;
  // ... provider-specific fields
}
```

### Example config.json

```json
{
  "activeProfile": "work",
  "profiles": {
    "work": {
      "provider": "sso",
      "model": "claude-4-5-sonnet",
      "baseUrl": "https://company.api.com"
    },
    "personal": {
      "provider": "anthropic",
      "model": "claude-4-5-sonnet",
      "authToken": "sk-ant-..."
    }
  }
}
```

### Operations

| Operation | Function | File |
|-----------|----------|------|
| **Load** | `ConfigLoader.load()` | src/utils/config.ts |
| **Save Profile** | `ConfigLoader.saveProfile()` | src/utils/config.ts |
| **Switch Profile** | `ConfigLoader.switchProfile()` | src/utils/config.ts |
| **Delete Profile** | `ConfigLoader.deleteProfile()` | src/utils/config.ts |

**Atomic Writes**: Write to temp file, then rename (prevents corruption)

---

## Session Data Storage (JSONL)

### JSONL Format (JSON Lines)

```jsonl
{"type":"conversation","id":"abc123","timestamp":"2026-01-16T10:00:00Z","messages":[...]}
{"type":"conversation","id":"def456","timestamp":"2026-01-16T11:00:00Z","messages":[...]}
```

**Why JSONL?**:
- Append-only (efficient for streaming)
- One record per line (easy to parse incrementally)
- No commas between records (simpler than JSON array)
- Resilient to corruption (one bad line doesn't break entire file)

### Reading JSONL

```typescript
// Source: src/providers/plugins/sso/session/utils/jsonl-reader.ts (pattern)
export class JSONLReader {
  async *readLines(filePath: string): AsyncGenerator<any> {
    const stream = fs.createReadStream(filePath, 'utf-8');
    const rl = readline.createInterface({ input: stream });

    for await (const line of rl) {
      if (line.trim()) {
        yield JSON.parse(line);
      }
    }
  }
}
```

**Benefits**: Memory-efficient streaming (doesn't load entire file)

---

## Writing JSONL

```typescript
// Source: src/providers/plugins/sso/session/utils/jsonl-writer.ts (pattern)
export class JSONLWriter {
  async appendLine(filePath: string, data: any): Promise<void> {
    const line = JSON.stringify(data) + '\n';
    await fs.appendFile(filePath, line, 'utf-8');
  }

  async appendBatch(filePath: string, records: any[]): Promise<void> {
    const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
    await fs.appendFile(filePath, lines, 'utf-8');
  }
}
```

**Atomic Append**: Node.js guarantees atomicity for single write operations

---

## Session Data Patterns

### Conversation History

```typescript
// Source: src/providers/plugins/sso/session/processors/conversations/conversation-types.ts
interface ConversationRecord {
  type: 'conversation';
  id: string;                    // Unique conversation ID
  timestamp: string;             // ISO 8601 timestamp
  messages: ConversationMessage[];
  metadata?: Record<string, unknown>;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
```

**Storage**: `~/.codemie/.session-{agent}/conversations.jsonl`

**Pattern**: Append-only (never modify existing records)

---

### Metrics Storage

```typescript
// Source: src/providers/plugins/sso/session/processors/metrics/metrics-types.ts
interface MetricRecord {
  type: 'metric';
  timestamp: string;
  sessionId: string;
  agent: string;
  provider: string;
  model: string;
  tokensUsed?: number;
  duration?: number;
  // ... other metrics
}
```

**Storage**: `~/.codemie/.session-{agent}/metrics.jsonl`

**Aggregation**: Read all records, aggregate in-memory (future: use database if scale increases)

---

## Encrypted Storage

**Algorithm**: AES-256-GCM (authenticated encryption)

**Master Key**: Derived from machine-specific identifier

**Storage**: `~/.codemie/.credentials` (encrypted JSON)

**Source**: src/utils/security.ts:200+ (CredentialStore class)

---

## Data Migration Pattern

### Config Migrations

```typescript
// Source: src/migrations/ (pattern)
export interface Migration {
  version: number;
  description: string;
  up(config: any): any;
  down(config: any): any;
}

// Example: Rename field migration
export const migration001: Migration = {
  version: 1,
  description: 'Rename apiKey to authToken',
  up(config) {
    if (config.apiKey) {
      config.authToken = config.apiKey;
      delete config.apiKey;
    }
    return config;
  },
  down(config) {
    if (config.authToken) {
      config.apiKey = config.authToken;
      delete config.authToken;
    }
    return config;
  }
};
```

**Registry**: `src/migrations/registry.ts` - list of all migrations

**Runner**: Applies migrations in order, tracks version

**Pattern**: Similar to database migrations, but for JSON config files

---

## Atomicity Guarantees

**Config Updates**: Write to temp file → Rename (atomic operation)

**Appends**: `fs.appendFile()` is atomic for single writes

**Why**: Prevents corruption on crash/interruption

---

## File Permissions

**Credentials**: `0o600` (owner-only) | **Config**: `0o644` (owner write, all read) | **Logs**: `0o644`

---

## Data Cleanup

### Log Rotation

```typescript
// Source: src/utils/logger.ts (pattern)
async function cleanupOldLogs(): Promise<void> {
  const logsDir = getCodemiePath('logs');
  const files = await fs.readdir(logsDir);
  const now = Date.now();
  const maxAge = 5 * 24 * 60 * 60 * 1000; // 5 days

  for (const file of files) {
    const stats = await fs.stat(path.join(logsDir, file));
    if (now - stats.mtimeMs > maxAge) {
      await fs.unlink(path.join(logsDir, file));
    }
  }
}
```

**Pattern**: Delete logs older than 5 days (automatic on startup)

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use JSONL for append-only data | JSON arrays for large datasets |
| Write to temp, then rename (atomic) | Overwrite directly (corruption risk) |
| Encrypt sensitive data (credentials) | Store secrets in plain text |
| Set file permissions (0o600 for secrets) | Default permissions for everything |
| Clean up old logs/sessions | Let data accumulate forever |
| Parse JSON with try/catch | Assume valid JSON |
| Use streaming for large JSONL files | Load entire file into memory |

---

## Performance Considerations

| Pattern | Performance Impact |
|---------|-------------------|
| **JSONL streaming** | O(1) memory (doesn't load entire file) |
| **Config loading** | O(n) where n = file size (~KB, negligible) |
| **Append operations** | O(1) time (no read required) |
| **Log rotation** | O(n) where n = number of log files (~5) |

**Bottlenecks**: None currently - file I/O is fast for small files

**Future**: If session data grows large (GB+), consider SQLite

---

## Testing Patterns

### Test Isolation

```typescript
// Pattern: Use temp directory for tests
import { setupTestIsolation } from '../../helpers/test-isolation.js';

describe('Config tests', () => {
  setupTestIsolation(); // Creates temp CODEMIE_HOME

  it('should save config', async () => {
    await ConfigLoader.saveProfile('test', testProfile);
    const loaded = await ConfigLoader.load(process.cwd());
    expect(loaded.profiles.test).toEqual(testProfile);
  });
});
```

**Helper**: `setupTestIsolation()` creates temp `~/.codemie` directory, cleans up after

**Source**: tests/helpers/test-isolation.ts

---

## References

- **Config Loader**: `src/utils/config.ts`
- **JSONL Reader**: `src/providers/plugins/sso/session/utils/jsonl-reader.ts`
- **JSONL Writer**: `src/providers/plugins/sso/session/utils/jsonl-writer.ts`
- **Credential Store**: `src/utils/security.ts` (CredentialStore class)
- **Path Utilities**: `src/utils/paths.ts`
- **Migrations**: `src/migrations/`
- **Session Types**: `src/providers/plugins/sso/session/processors/`

---

## Related Guides

- Security Practices: .codemie/guides/security/security-practices.md
- Development Practices: .codemie/guides/development/development-practices.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
