# Agent Plugin Development Guide

This guide shows you how to add new AI agent integrations to CodeMie CLI using the plugin pattern.

**Reference implementations**: `src/agents/plugins/` → `claude.plugin.ts`, `codex.plugin.ts`, `gemini.plugin.ts`, `deepagents.plugin.ts`

## Quick Start (4 Steps)

1. **Create Plugin File** (`src/agents/plugins/newagent.plugin.ts`)
2. **Register in Registry** (`src/agents/registry.ts`)
3. **Add Binary Entry** (`package.json`)
4. **Build & Test** (`npm run build && npm link`)

---

## Step 1: Create Plugin File

### Minimal Plugin (npm-based agent)

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

### Advanced Features (optional)

```typescript
export const AdvancedAgentMetadata: AgentMetadata = {
  // ... basic fields ...

  // === SSO/Proxy Support (for ai-run-sso provider) ===
  ssoConfig: {
    enabled: true,
    clientType: 'codemie-newagent',          // Unique client identifier
    envOverrides: {
      baseUrl: 'NEWAGENT_BASE_URL',          // Which env var to override with proxy URL
      apiKey: 'NEWAGENT_API_KEY'             // Which env var to override with proxy token
    }
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
  },

  // === Analytics Adapter (optional) ===
  analyticsAdapter: new NewAgentAnalyticsAdapter(metadata)
};
```

### Non-npm Plugin (Python/pip-based)

**Example**: Deep Agents CLI (installed via pip/uv instead of npm)

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
      // Try uv first, fallback to pip
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

---

## Step 2: Register Plugin

**File**: `src/agents/registry.ts`

```typescript
import { NewAgentPlugin } from './plugins/newagent.plugin.js';

static {
  // Add to initialization block (bottom of list)
  AgentRegistry.registerPlugin(new NewAgentPlugin());
}
```

---

## Step 3: Add Binary Entry

**File**: `package.json` → `bin` section

```json
{
  "bin": {
    "codemie-newagent": "./bin/agent-executor.js"
  }
}
```

**Why This Works**: `agent-executor.js` extracts agent name from executable (`codemie-newagent` → `newagent`) and loads the plugin dynamically from the registry.

---

## Step 4: Build & Test

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

**Use Case**: Block incompatible models (e.g., OpenAI-only agent should reject Claude models)

```typescript
blockedModelPatterns: [/^claude/i],  // Block Claude models
```

### Pattern 2: Environment Setup (Codex)

**Use Case**: Create required config files/directories before execution

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

**Use Case**: Agent uses different SDK internally (e.g., Anthropic agent using OpenAI SDK for proxying)

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

**Use Case**: Disable experimental features for stability

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

**Use Case**: Support multiple naming conventions for same variable

```typescript
envMapping: {
  baseUrl: ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_BASE_URL'],  // Try first, fallback to second
  apiKey: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  model: ['GEMINI_MODEL']
}
```

### Pattern 6: Model Argument Injection (Codex, Gemini)

**Use Case**: Agent CLI requires model as explicit argument

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

**Use Case**: Agent uses hashed project IDs, need mapping for analytics

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

---

## Validation Checklist

Before submitting:

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

---

## Architecture Benefits

✅ **Zero Core Changes**: No modifications to `BaseAgentAdapter` or registry logic
✅ **Auto-Discovery**: Analytics, health checks, shortcuts all work automatically
✅ **Type-Safe**: Full TypeScript support with `AgentMetadata` interface
✅ **Reusable Logic**: `BaseAgentAdapter` handles install/uninstall/run/proxy
✅ **Extensible**: Override methods for custom install logic (pip, cargo, etc.)

---

## AgentMetadata Interface Reference

```typescript
interface AgentMetadata {
  // === Identity ===
  name: string;                              // Internal ID (e.g., 'claude')
  displayName: string;                       // User-facing name (e.g., 'Claude Code')
  description: string;

  // === Installation ===
  npmPackage: string | null;                 // npm package or null for built-in
  cliCommand: string | null;                 // CLI executable or null for built-in

  // === Environment Variable Mapping ===
  envMapping: {
    baseUrl?: string[];                      // Fallback chain for base URL
    apiKey?: string[];                       // Fallback chain for API key
    model?: string[];                        // Fallback chain for model
  };

  // === Compatibility Rules ===
  supportedProviders: string[];              // ['openai', 'litellm', 'ai-run-sso']
  blockedModelPatterns?: RegExp[];           // [/^claude/i] - block incompatible models

  // === Proxy Configuration (SSO) ===
  ssoConfig?: {
    enabled: boolean;
    clientType: string;                      // Unique client identifier
    envOverrides: {
      baseUrl: string;                       // Env var to override with proxy URL
      apiKey: string;                        // Env var to override with proxy token
    };
  };

  // === CLI Options ===
  customOptions?: Array<{
    flags: string;                           // '--plan'
    description: string;
  }>;

  // === Runtime Behavior ===
  argumentTransform?: (args: string[], config: AgentConfig) => string[];

  lifecycle?: {
    beforeRun?: (env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
    afterRun?: (exitCode: number) => Promise<void>;
  };

  // === Data Paths (for analytics) ===
  dataPaths?: {
    home: string;                            // Main directory: '~/.agent'
    sessions?: string;                       // Session logs (relative to home)
    settings?: string;                       // Settings file (relative to home)
    cache?: string;                          // Cache directory (relative to home)
  };

  // === Analytics Support ===
  analyticsAdapter?: AgentAnalyticsAdapter;  // Optional analytics adapter
}
```

---

## Troubleshooting

### Plugin not recognized
- Check registration in `AgentRegistry.registerPlugin()`
- Verify plugin name matches binary name: `codemie-{name}` → `{name}`
- Run `npm run build` after changes

### Health check fails
- Verify agent is installed: `which {cliCommand}`
- Check `isInstalled()` logic
- Test manual execution: `{cliCommand} --version`

### Model validation errors
- Check `blockedModelPatterns` configuration
- Verify `supportedProviders` list
- Review model validation in `BaseAgentAdapter`

### Proxy/SSO not working
- Verify `ssoConfig.enabled = true`
- Check `envOverrides` match agent's expected variables
- Confirm `clientType` is unique across plugins
- Test with: `codemie-{name} --provider ai-run-sso "test"`

### Environment variables not passed
- Check `envMapping` configuration
- Verify variable names match agent's expectations
- Use `lifecycle.beforeRun` to log env for debugging

---

## Examples

See existing plugins for complete examples:
- **Claude** (`claude.plugin.ts`): Basic plugin with SSO, feature flags
- **Codex** (`codex.plugin.ts`): Model injection, config file setup
- **Gemini** (`gemini.plugin.ts`): Project mapping, multi-var fallbacks
- **Deep Agents** (`deepagents.plugin.ts`): Python/pip installation, variable remapping
