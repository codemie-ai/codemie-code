# Agent System Development Guide

This guide provides comprehensive documentation for developing agents in the CodeMie CLI.

**Context**: This file is loaded automatically when working in `src/agents/**`. It contains complete guidance for agent plugin development, lifecycle hooks, and integration patterns.

---

## Overview

The Agent System uses a **plugin-based architecture with lifecycle hooks** that enables:
- Provider-agnostic agent implementations
- Runtime hook resolution for dynamic behavior
- Zero compile-time dependencies between agents and providers
- Easy addition of new agents without modifying core code

---

## Core Architecture

### Core Components (`core/`)

- **AgentAdapter**: Interface that all agents must implement
- **AgentCLI**: Universal CLI builder from agent metadata
- **BaseAgentAdapter**: Shared implementation for external agents (npm/pip-based)
- **Lifecycle Helpers** (`lifecycle-helpers.ts`): Hook resolution system
  - Implements Chain of Responsibility pattern for hook execution
  - Runtime resolution of provider-specific hooks
  - Automatic hook chaining (wildcard + agent-specific)
  - Zero dependencies between agent and provider code

### Agent Plugins (`plugins/`)

Self-contained, provider-agnostic implementations:
- `claude.plugin.ts`: Claude Code with default lifecycle hooks
- `codex.plugin.ts`: Codex with model injection
- `gemini.plugin.ts`: Gemini CLI with project mapping
- `deepagents.plugin.ts`: Deep Agents (Python/pip-based)
- `codemie-code.plugin.ts`: Built-in agent plugin wrapper

### Built-in Agent (`codemie-code/`)

Full LangGraph-based coding assistant with:
- File operations (read, write, list directory)
- Command execution with security filtering
- Planning and todo management
- Multi-provider support via ConfigLoader

### Session Infrastructure (`core/session/` and `core/metrics/`)

**Separation of Concerns**: Session management is separated from metrics collection for clarity and reusability.

#### Session Infrastructure (`core/session/`)

Shared by ALL processors (metrics, conversations, future processors):

- **`types.ts`**: Core session types used across all processors
  - `Session`: Central session metadata with correlation, monitoring, sync state
  - `FileInfo`, `FileSnapshot`: Directory snapshot types
  - `CorrelationResult`, `CorrelationStatus`: Session file correlation
  - `SessionStatus`: Session lifecycle states (`active`, `completed`, `failed`)
  - `SyncState`: Hierarchical sync state (`session.sync.metrics`, `session.sync.conversations`)
  - `MetricsSyncState`, `ConversationsSyncState`: Processor-specific sync state

- **`SessionOrchestrator.ts`**: Central session lifecycle manager
  - Creates session metadata before agent spawn
  - Correlates CodeMie session with agent session files
  - Monitors session activity and collects metrics deltas
  - **Two-Phase Completion Pattern**:
    1. `prepareForExit()`: Stop monitoring, collect final deltas
    2. Proxy cleanup triggers sync (metrics + conversations)
    3. `markSessionComplete()`: Mark session status AFTER sync completes
  - Used by both metrics and conversations processors

- **`SessionStore.ts`**: Session persistence to `~/.codemie/metrics/sessions/{sessionId}.json`
- **`SessionCorrelator.ts`**: Correlates CodeMie sessions with agent session files
- **`FileSnapshotter.ts`**: Directory snapshots for correlation (before/after agent spawn)

#### Metrics Infrastructure (`core/metrics/`)

Metrics-specific functionality:

- **`types.ts`**: Metrics-specific types + minimal re-exports
  - Only re-export types actually used by external consumers
  - Metrics types: `MetricDelta`, `MetricSnapshot`, `ToolCallMetric`, `Watermark`, etc.
  - Re-exports: `Session`, `SyncStatus`, `MetricsSyncState` (needed by metrics code)

- **`DeltaWriter.ts`**: Writes metrics deltas to `~/.codemie/metrics/{sessionId}_metrics.jsonl`
- **`MetricsSyncStateManager.ts`**: Manages `session.sync.metrics` state
  - Tracks processed record IDs, last processed line, sync statistics
  - Prevents duplicate delta processing during incremental collection

#### Type Organization Best Practices

1. **Import from Source**: Components should import types from their source module
   ```typescript
   // ✅ CORRECT: Import session types from session/types.ts
   import type { Session, FileSnapshot } from './types.js';

   // ❌ WRONG: Import session types from metrics/types.ts
   import type { Session } from '../metrics/types.js';
   ```

2. **Minimal Re-exports**: Only re-export types actually used by external consumers
   ```typescript
   // ✅ CORRECT: metrics/types.ts only re-exports what's needed
   export type { Session, SyncStatus, MetricsSyncState } from '../session/types.js';

   // ❌ WRONG: Re-exporting everything "just in case"
   export type { FileInfo, FileSnapshot, ... } from '../session/types.js';
   ```

3. **Use `export type { } from` syntax**: Cleaner than separate import + export
   ```typescript
   // ✅ CORRECT: Single statement
   export type { Session } from '../session/types.js';

   // ❌ AVOID: Separate statements
   import type { Session } from '../session/types.js';
   export type { Session };
   ```

#### Two-Phase Session Completion Pattern

**Problem**: Need to ensure metrics and conversations are synced BEFORE marking session as completed.

**Solution**: Split completion into two phases in `BaseAgentAdapter`:

```typescript
// Phase 1: Prepare for exit (collect final data)
if (this.sessionOrchestrator && code !== null) {
  await this.sessionOrchestrator.prepareForExit();
}

// Lifecycle hooks run (onSessionEnd)
await executeOnSessionEnd(this, this.metadata.lifecycle, this.metadata.name, code, env);

// Proxy cleanup triggers final sync
// SSOSessionSyncPlugin.onProxyStop() syncs metrics + conversations
await cleanup();

// Phase 2: Mark session complete (AFTER sync)
if (this.sessionOrchestrator && code !== null) {
  await this.sessionOrchestrator.markSessionComplete(code);
}
```

**Key Points**:
- `prepareForExit()`: Stop file watcher, collect final deltas
- Proxy cleanup triggers `SSOSessionSyncPlugin.onProxyStop()` which runs all processors
- `markSessionComplete()`: Update session status ONLY after sync completes
- Ensures `session.status` accurately reflects sync completion

---

## Critical Principle: Provider-Agnostic Design

**Agents NEVER hardcode provider logic**. They define ONLY default behavior.

```typescript
// ✅ CORRECT: Provider-agnostic agent
export const NewAgentMetadata: AgentMetadata = {
  name: 'newagent',
  lifecycle: {
    // ONLY default hooks - no provider knowledge!
    beforeRun: async (env, config) => {
      env.NEWAGENT_DISABLE_TELEMETRY = '1';
      return env;
    }
  }
};

// ❌ WRONG: Provider-specific logic in agent
export const BadAgentMetadata: AgentMetadata = {
  lifecycle: {
    beforeRun: async (env, config) => {
      // DON'T DO THIS - no provider checks in agent code!
      if (env.CODEMIE_PROVIDER === 'bedrock') {
        env.NEWAGENT_USE_BEDROCK = '1';
      }
      return env;
    }
  }
};
```

**Why This Works**: Providers register hooks that customize agent behavior at runtime. Agents remain testable and maintainable without provider dependencies.

---

## Lifecycle Hooks System

### Hook Types (Execution Order)

1. **`onSessionStart(sessionId, env)`** - Early initialization before env transformation
2. **`beforeRun(env, config)`** - After env transformation, before agent execution
3. **`enrichArgs(args, config)`** - CLI argument injection and transformation
4. **[Agent execution]**
5. **`onSessionEnd(exitCode, env)`** - Late cleanup after execution
6. **`afterRun(exitCode, env)`** - Final cleanup and post-processing

### Hook Resolution Priority (Loose Coupling)

When an agent runs, hooks are resolved in this order:

1. **Provider wildcard hook** (`ProviderTemplate.agentHooks['*']`) - Applies to ALL agents
2. **Provider agent-specific hook** (`ProviderTemplate.agentHooks[agentName]`) - Runs on top of wildcard
3. **Agent default hook** (`AgentMetadata.lifecycle`) - Fallback if no provider hooks exist

**Automatic Chaining**: When both wildcard and agent-specific hooks exist:
- Wildcard runs first (e.g., transforms AWS credentials)
- Agent-specific runs second (e.g., enables Bedrock mode)
- Each receives the result from the previous hook

```typescript
// Execution flow for 'newagent' with Bedrock provider:
// 1. BedrockTemplate.agentHooks['*'].beforeRun (AWS credentials)
// 2. BedrockTemplate.agentHooks['newagent'].beforeRun (Bedrock mode)
// 3. NewAgentMetadata.lifecycle.beforeRun (if provider hooks don't exist)
```

---

## Adding New Agents (4 Steps)

### Quick Start

1. **Create plugin file**: `src/agents/plugins/{name}.plugin.ts`
2. **Register in registry**: `src/agents/registry.ts`
3. **Add binary entry**: `package.json` → `bin` section
4. **Build & test**: `npm run build && npm link`

### Step 1: Create Plugin File

#### Minimal Plugin (npm-based agent)

```typescript
import { AgentMetadata } from '../core/types.js';
import { BaseAgentAdapter } from '../core/BaseAgentAdapter.js';

export const NewAgentPluginMetadata: AgentMetadata = {
  // === Identity ===
  name: 'newagent',                          // Internal ID (matches codemie-newagent)
  displayName: 'New Agent',                  // User-facing name
  description: 'AI coding assistant',

  // === Installation ===
  npmPackage: '@vendor/newagent-cli',        // npm package name
  cliCommand: 'newagent',                    // CLI executable name

  // === Environment Variable Mapping ===
  envMapping: {
    baseUrl: ['NEWAGENT_BASE_URL'],          // Fallback chain for base URL
    apiKey: ['NEWAGENT_API_KEY'],            // Fallback chain for API key
    model: ['NEWAGENT_MODEL']                // Fallback chain for model
  },

  // === Compatibility Rules ===
  supportedProviders: ['litellm', 'ai-run-sso'],
  blockedModelPatterns: []                   // Block incompatible models: [/^claude/i]
};

export class NewAgentPlugin extends BaseAgentAdapter {
  constructor() {
    super(NewAgentPluginMetadata);
  }
}
```

#### Advanced Features (optional)

```typescript
export const AdvancedAgentMetadata: AgentMetadata = {
  // ... basic fields ...

  // === SSO/Proxy Support (for ai-run-sso provider) ===
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-newagent'           // Unique client identifier
  },

  // === Model Injection (if agent needs --model flag) ===
  argumentTransform: (args, config) => {
    const hasModel = args.some((arg, i) =>
      (arg === '-m' || arg === '--model') && i < args.length - 1
    );
    if (!hasModel && config.model) {
      return ['--model', config.model, ...args];  // Prepend model arg
    }
    return args;
  },

  // === Lifecycle Hooks ===
  lifecycle: {
    async beforeRun(env, config) {
      // Setup required directories, config files
      // Transform environment variables
      // Validate prerequisites
      return env;  // Return modified env
    },
    async afterRun(exitCode) {
      // Cleanup, telemetry
    }
  },

  // === Data Paths (for analytics) ===
  dataPaths: {
    home: '~/.newagent',                     // Main directory
    sessions: 'sessions',                    // Relative to home
    settings: 'config.json'                  // Relative to home
  }
};
```

#### Non-npm Plugin (Python/pip-based)

For agents installed via pip/uv instead of npm:

```typescript
import { exec } from '../../utils/exec.js';
import { logger } from '../../utils/logger.js';

export class PythonAgentPlugin extends BaseAgentAdapter {
  constructor() {
    super(PythonAgentMetadata);
  }

  async install(): Promise<void> {
    logger.info('Installing via pip...');
    try {
      // Try uv first (faster), fallback to pip
      try {
        await exec('uv', ['tool', 'install', 'package-name'], { timeout: 120000 });
        logger.success('Installed via uv');
      } catch {
        await exec('pip', ['install', 'package-name'], { timeout: 120000 });
        logger.success('Installed via pip');
      }
    } catch (error) {
      throw new Error(`Installation failed: ${error.message}`);
    }
  }

  async uninstall(): Promise<void> {
    logger.info('Uninstalling...');
    try {
      try {
        await exec('uv', ['tool', 'uninstall', 'package-name']);
        logger.success('Uninstalled');
      } catch {
        await exec('pip', ['uninstall', '-y', 'package-name']);
        logger.success('Uninstalled');
      }
    } catch (error) {
      throw new Error(`Uninstallation failed: ${error.message}`);
    }
  }
}
```

### Step 2: Register Plugin

**File**: `src/agents/registry.ts`

```typescript
import { NewAgentPlugin } from './plugins/newagent.plugin.js';

static {
  // Add to initialization block (bottom of list)
  AgentRegistry.registerPlugin(new NewAgentPlugin());
}
```

### Step 3: Add Binary Entry Point

Create a dedicated entry point for your agent:

**File**: `bin/codemie-newagent.js`

```javascript
#!/usr/bin/env node

/**
 * New Agent Entry Point
 * Direct entry point for codemie-newagent command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('newagent');
if (!agent) {
  console.error('✗ New Agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
```

**File**: `package.json` → `bin` section

```json
{
  "bin": {
    "codemie-newagent": "./bin/codemie-newagent.js"
  }
}
```

**Why Dedicated Entry Points**: Each agent has its own bin file to avoid Windows npm wrapper detection issues. The pattern is: `bin/codemie-{agentname}.js` loads agent from registry and passes to `AgentCLI`.

### Step 4: Build & Test

```bash
npm run build && npm link        # Build and link for local development
codemie install newagent         # Install the agent
codemie-newagent health          # Test health check
codemie-newagent "hello"         # Test execution

# Test with profile
codemie setup                    # Configure a profile first
codemie-newagent --profile default "test task"

# Test with overrides
codemie-newagent --model gpt-4 --provider openai "test"
```

---

## Real-World Patterns

### Pattern 1: Model Compatibility (Codex)

Block incompatible models (e.g., OpenAI-only agent should reject Claude models):

```typescript
blockedModelPatterns: [/^claude/i],  // Block Claude models
```

### Pattern 2: Environment Setup (Codex)

Create required config files/directories before execution:

```typescript
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

lifecycle: {
  async beforeRun(env) {
    // Create required config directory
    const configDir = join(homedir(), '.codex');
    if (!existsSync(configDir)) {
      await mkdir(configDir, { recursive: true });
    }

    // Create auth file if missing
    const authFile = join(configDir, 'auth.json');
    if (!existsSync(authFile)) {
      await writeFile(authFile, JSON.stringify({
        OPENAI_API_KEY: env.OPENAI_API_KEY || 'proxy-handled'
      }, null, 2));
    }

    return env;
  }
}
```

### Pattern 3: Variable Remapping (Deep Agents)

Agent uses different SDK internally (e.g., Anthropic agent using OpenAI SDK for proxying):

```typescript
lifecycle: {
  async beforeRun(env) {
    // Deep Agents uses OpenAI SDK internally
    // When using custom base URL, remap to OpenAI vars
    if (env.OPENAI_BASE_URL && !env.OPENAI_API_KEY && env.ANTHROPIC_API_KEY) {
      env.OPENAI_API_KEY = env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_BASE_URL;
    }
    return env;
  }
}
```

### Pattern 4: Feature Flags (Claude)

Disable experimental features for stability:

```typescript
lifecycle: {
  async beforeRun(env) {
    // Disable experimental features
    if (!env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS) {
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
    }
    return env;
  }
}
```

### Pattern 5: Multiple Environment Variables (Gemini)

Support multiple naming conventions for same variable:

```typescript
envMapping: {
  baseUrl: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],  // Try first, fallback to second
  apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  model: ['GEMINI_MODEL']
}
```

### Pattern 6: Model Argument Injection (Codex, Gemini)

Agent CLI requires model as explicit argument:

```typescript
argumentTransform: (args, config) => {
  // Check if model is already specified
  const hasModelArg = args.some((arg, idx) =>
    (arg === '-m' || arg === '--model') && idx < args.length - 1
  );

  // Inject model if not present
  if (!hasModelArg && config.model) {
    return ['--model', config.model, ...args];
  }

  return args;
}
```

### Pattern 7: Project Mapping for Analytics (Gemini)

Agent uses hashed project IDs, need mapping for analytics:

```typescript
import { registerCurrentProject } from '../../analytics/aggregation/core/project-mapping.js';

lifecycle: {
  beforeRun: async (env) => {
    // Register current working directory for project mapping
    // Creates/updates ~/.codemie/gemini-project-mappings.json
    // so analytics can resolve project hashes to actual paths
    registerCurrentProject('gemini', process.cwd());

    return env;
  }
}
```

### Pattern 8: Metrics Support (Codex)

Agents can provide metrics adapters to enable analytics collection. The Codex implementation demonstrates the complete pattern:

#### Codex-Specific Metrics Architecture

**File Structure**:
- `codex.plugin.ts` - Main plugin with `getMetricsAdapter()` method
- `codex.metrics.ts` - Metrics adapter implementation extending `BaseMetricsAdapter`
- Tests split by concern:
  - `__tests__/codex.metrics.test.ts` - Unit tests for path matching and parsing logic
  - `../../tests/integration/codex-metrics.test.ts` - Integration tests with real fixture data

**Key Implementation Details**:

1. **Date-Based Session Structure**: Codex uses hierarchical date structure `~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{date}T{time}-{uuid}.jsonl`
   - Pattern matching must handle dynamic date paths
   - `getDataPaths()` returns base directory for scanning
   - `matchesSessionPattern()` validates full structure including date folders

2. **Session File Format**: JSONL with event stream
   - `session_meta` - Contains session ID, working directory, git branch, model provider
   - `turn_context` - Tracks model per turn
   - `event_msg` with `token_count` - Contains cumulative token usage
   - `response_item` with `function_call` / `function_call_output` - Tool call pairs

3. **Token Calculation Strategy**:
   - Codex provides **cumulative** token counts in `total_token_usage`
   - Calculate deltas: `Math.max(0, current - previous)` to get incremental usage
   - **Always combine output + reasoning tokens**: `output_tokens + reasoning_output_tokens`
   - Use `last_token_usage` for validation (Codex's own delta calculation)
   - Skip duplicate `token_count` events (produce 0 delta)

4. **Tool Call Correlation**:
   - Two-pass algorithm:
     - First pass: Build map of `function_call` events by `call_id`
     - Second pass: Match `function_call_output` with requests using `call_id`
   - Parse double-encoded JSON: `JSON.parse(event.payload.output)`
   - Extract exit codes, duration, and error messages from metadata
   - Create file operations from tool arguments

5. **Cross-Platform Path Handling**:
   - Use regex with `[\\/]` for both Unix and Windows separators
   - Case-insensitive directory matching: `pathLower.includes('.codex')`
   - Extract filename with utility: `getFilename(path)` handles both path formats

6. **Performance Optimization - Date Filtering**:
   - Default: Only match today's sessions (`dateFilter` defaults to current date)
   - Pass `null` to match all dates (used for historical analysis)
   - Reduces filesystem operations by 95%+ for real-time monitoring

7. **Watermark Strategy**: Use `object` strategy with record IDs
   - Format: `{sessionId}:{timestamp}:{eventIndex}`
   - Prevents duplicate processing across incremental scans

**Plugin Integration**:
```typescript
export class CodexPlugin extends BaseAgentAdapter {
  private metricsAdapter: AgentMetricsSupport;

  constructor() {
    super(CodexPluginMetadata);
    // Pass metadata to avoid duplication
    this.metricsAdapter = new CodexMetricsAdapter(CodexPluginMetadata);
  }

  getMetricsAdapter(): AgentMetricsSupport {
    return this.metricsAdapter;
  }
}
```

**Configuration via CLI Arguments**:
Codex now uses CLI-based configuration instead of `config.toml` modification:
```typescript
enrichArgs: (args, config) => {
  const cliArgs: string[] = [];
  const providerName = config.profileName || config.provider || 'codemie';

  // Define model provider via --config flags
  if (baseUrl) {
    cliArgs.push('--config', `model_providers.${providerName}.name="${providerName}"`);
    cliArgs.push('--config', `model_providers.${providerName}.base_url="${baseUrl}"`);

    // Set wire_api (defaults to "responses", override via CODEMIE_CODEX_WIRE_API)
    const wireApi = process.env.CODEMIE_CODEX_WIRE_API || 'responses';
    cliArgs.push('--config', `model_providers.${providerName}.wire_api="${wireApi}"`);

    cliArgs.push('--config', `model_provider="${providerName}"`);
  }

  return [...cliArgs, ...args];
}
```

**Testing Strategy**:
- **Unit tests** (`__tests__/`): Pattern matching, parsing logic, edge cases
  - Must include: `getWatermarkStrategy()`, `getInitDelay()`, `getDataPaths()`
  - Cross-platform path validation (Unix, Windows, mixed separators)
  - Agent-specific pattern validation (UUID format, date structure, etc.)
- **Integration tests** (`../../tests/integration/metrics/`): Full pipeline with real session fixtures
  - Location: Metrics tests moved to dedicated `metrics/` subfolder
  - Specialized documentation: `tests/integration/metrics/CLAUDE.md`
- **Golden dataset verification**: Delta totals MUST equal snapshot totals (mathematical proof)
- **Performance**: Integration tests must complete in < 200ms per file

**Critical Unit Tests (Mandatory)**:
```typescript
describe('Adapter Configuration', () => {
  it('should use correct watermark strategy', () => {
    // Claude: 'hash' | Codex: 'object' | Gemini: 'line'
    expect(adapter.getWatermarkStrategy()).toBe('hash');
  });

  it('should have correct initialization delay', () => {
    expect(adapter.getInitDelay()).toBe(500); // Standard: 500ms
  });

  it('should detect correct data paths', () => {
    const dataPaths = adapter.getDataPaths();
    expect(dataPaths.sessionsDir).toContain('.agent');
  });
});
```

**Integration Test Requirements** (see `tests/integration/metrics/CLAUDE.md`):
- **Mandatory verification suite**: 6 sections (adapter config, session ID, snapshot, deltas, pipeline, end-to-end)
- **Mathematical verification**: `Σ(deltas.tokens) === snapshot.tokens` (critical!)
- **Golden dataset**: Expected values documented in `fixtures/{agent}/README.md`
- **Minimum 17-20 tests** per agent with complete verification
- Use real production session files (< 50KB)
- Parse once in `beforeAll`, validate in test cases

**Reference Implementations**:
- Unit: `src/agents/plugins/__tests__/codex.metrics.test.ts` (34 tests, 4ms)
- Integration: `tests/integration/metrics/codex-metrics.test.ts` (48 tests, 15ms)

---

## Built-in Agent Development (LangGraph)

When working on CodeMie Native (`src/agents/codemie-code/`):

### Tools System (`tools/`)

Modular tool implementations:
- **Core tools** (`index.ts`): `ReadFileTool`, `WriteFileTool`, `ListDirectoryTool`, `ExecuteCommandTool`
- **Planning tools** (`planning.ts`): Todo management and progress tracking
- All tools extend LangChain's `StructuredTool` class with Zod schemas
- Implement security filtering (path traversal prevention, dangerous command blocking)
- Include progress tracking with `emitToolProgress()` for long-running operations
- Cross-platform compatibility (Windows/Linux/macOS path handling)

### UI System (`ui.ts`, `streaming/`)

Terminal interface:
- Use Clack components for consistency
- Implement streaming event handlers for real-time updates
- Separate UI concerns from business logic

### Configuration (`config.ts`)

Provider-agnostic config loading:
- Use `ConfigLoader` for multi-provider support
- Validate configuration before agent initialization
- Support CLI overrides and environment variables

### Error Handling

Structured, contextual errors:
- Create specific error classes for different failure modes
- Include actionable error messages with suggestions
- Log errors appropriately for debugging

### Planning System (`modes/`)

Optional planning feature:
- Context-aware planning that explores codebase first
- Todo-based tracking with quality validation
- Persistent state management across sessions

## Validation Checklist

- ✅ Plugin file follows naming convention (`{name}.plugin.ts`)
- ✅ Registered in `AgentRegistry.registerPlugin()`
- ✅ Binary entry added to `package.json`
- ✅ Environment variables documented in plugin metadata
- ✅ Model compatibility rules defined (`blockedModelPatterns`)
- ✅ SSO config specified (if using ai-run-sso provider)
- ✅ Lifecycle hooks implemented (if needed for setup)
- ✅ Health check works (`codemie-{name} health`)
- ✅ Execution works with profile (`codemie-{name} --profile default "test"`)
- ✅ ESLint passes (`npm run lint`)
- ✅ Builds successfully (`npm run build`)

## Reference Implementations

- **`claude.plugin.ts`**: Basic plugin with SSO, feature flags
- **`codex.plugin.ts`**: Model injection, config file setup
- **`gemini.plugin.ts`**: Project mapping, multi-var fallbacks
- **`deepagents.plugin.ts`**: Python/pip installation, variable remapping

## Architecture Benefits

✅ **Zero Core Changes** - No modifications to `BaseAgentAdapter` or registry logic
✅ **Auto-Discovery** - Analytics, health checks, shortcuts all work automatically
✅ **Type-Safe** - Full TypeScript support with `AgentMetadata` interface
✅ **Reusable Logic** - `BaseAgentAdapter` handles install/uninstall/run/proxy
✅ **Extensible** - Override methods for custom install logic (pip, cargo, etc.)
