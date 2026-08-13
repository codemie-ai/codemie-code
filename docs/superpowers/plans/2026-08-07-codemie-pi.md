# codemie-pi Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `codemie-pi` agent plugin that installs the upstream Pi npm package and launches it against the CodeMie proxy with a dynamically generated `models.json`.

**Architecture:** Follow the existing agent plugin pattern (`src/agents/plugins/<agent>/`). A new `PiPlugin` extends `BaseAgentAdapter`, implements `beforeRun` to prepare a CodeMie-managed Pi agent directory, and `enrichArgs` to inject `--provider` and `--model`. Model catalogue generation is isolated in `pi.models.ts`; path helpers live in `pi.paths.ts`.

**Tech Stack:** TypeScript, ES modules, Node.js `fs/promises`, existing `fetchCodeMieLlmModels` / `CodeMieSSO` utilities.

## Global Constraints

- Node.js >= 20.0.0.
- ES modules only; imports use `.js` extensions.
- No `console.log` for debug output; use `logger.debug()`.
- All new exports have explicit return types.
- No `any`; use `unknown` + narrowing or precise types.
- Tests are out of scope unless explicitly requested by the user.
- Session analytics / MCP injection / skills mapping are out of scope for this first version.
- Use `@/` alias for deep imports; avoid `../../..` relative paths.

---

## Task 1: Pi path helpers

**Files:**
- Create: `src/agents/plugins/pi/pi.paths.ts`

**Interfaces:**
- Produces: `getPiAgentDir(cwd?: string): string` — returns `<cwd>/.pi/codemie/agent`.
- Produces: `getUserPiAgentDir(): string` — returns `~/.pi/agent`.
- Produces: `getPiModelsPath(cwd?: string): string` — returns `models.json` path inside the CodeMie-managed dir.

- [ ] **Step 1: Implement path helpers**

```typescript
import { join } from 'path';
import { homedir } from 'os';

export function getUserPiAgentDir(): string {
  return join(homedir(), '.pi', 'agent');
}

export function getPiAgentDir(cwd: string = process.cwd()): string {
  return join(cwd, '.pi', 'codemie', 'agent');
}

export function getPiModelsPath(cwd: string = process.cwd()): string {
  return join(getPiAgentDir(cwd), 'models.json');
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`  
Expected: No errors related to the new file.

---

## Task 2: Pi model catalogue builder

**Files:**
- Create: `src/agents/plugins/pi/pi.models.ts`

**Interfaces:**
- Consumes: `LlmModel` from `src/providers/plugins/sso/sso.http-client.js`.
- Produces: `fetchAndBuildPiModels(env: NodeJS.ProcessEnv, cwd?: string): Promise<void>` — fetches live models and writes `<cwd>/.pi/codemie/agent/models.json`.
- Produces: `classifyPiModel(modelId: string): PiModelClassification` — returns provider section and API override.

- [ ] **Step 1: Define classification types and patterns**

```typescript
export interface PiModelClassification {
  provider: 'codemie-proxy' | 'codemie-anthropic';
  api?: 'openai-responses';
}

const RESPONSES_API_PATTERNS: RegExp[] = [
  /^gpt-5-2-/,
  /^gpt-5\.2-/,
  /^gpt-5-1-codex/,
  /^gpt-5\.1-codex/,
  /^gpt-5-3-codex/,
  /^gpt-5\.3-codex/,
  /^gpt-5\.4-/,
  /^gpt-5-4-/,
  /^gpt-5\.5-/,
  /^gpt-5-5-/,
  /^gpt-5\.6-/,
  /^gpt-5-6-/,
];

export function classifyPiModel(modelId: string): PiModelClassification {
  if (modelId.startsWith('claude')) {
    return { provider: 'codemie-anthropic' };
  }
  if (RESPONSES_API_PATTERNS.some(pattern => pattern.test(modelId))) {
    return { provider: 'codemie-proxy', api: 'openai-responses' };
  }
  return { provider: 'codemie-proxy' };
}
```

- [ ] **Step 2: Implement model metadata heuristics**

```typescript
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';

export interface PiModelEntry {
  id: string;
  name: string;
  api?: 'openai-responses';
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  compat?: Record<string, unknown>;
}

function detectLimits(id: string): { contextWindow: number; maxTokens: number } {
  if (id.startsWith('claude')) return { contextWindow: 200000, maxTokens: 64000 };
  if (id.startsWith('gemini')) return { contextWindow: 1048576, maxTokens: 65536 };
  if (id.startsWith('gpt-4.1')) return { contextWindow: 1048576, maxTokens: 32768 };
  if (/^gpt-5\.5-/.test(id) || /^gpt-5-5-/.test(id)) return { contextWindow: 1050000, maxTokens: 128000 };
  if (/^gpt-5\.6-/.test(id) || /^gpt-5-6-/.test(id)) return { contextWindow: 1050000, maxTokens: 128000 };
  if (id.startsWith('gpt-5')) return { contextWindow: 400000, maxTokens: 128000 };
  if (/^o[134]-/.test(id) || id === 'o1') return { contextWindow: 200000, maxTokens: 100000 };
  if (id.startsWith('qwen') || id.startsWith('moonshotai') || id.startsWith('kimi')) {
    return { contextWindow: 262144, maxTokens: 131072 };
  }
  if (id.startsWith('deepseek')) return { contextWindow: 65536, maxTokens: 65536 };
  return { contextWindow: 128000, maxTokens: 4096 };
}

function defaultThinkingLevelMap(): Record<string, string | null> {
  return {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
}

function isReasoningModel(id: string): boolean {
  return (
    id.startsWith('claude') ||
    id.startsWith('gemini') ||
    id.startsWith('gpt-5') ||
    /^o[134]-/.test(id) ||
    id === 'o1' ||
    id.startsWith('deepseek') ||
    id.startsWith('moonshotai') ||
    id.startsWith('kimi')
  );
}

export function convertLlmModelToPiEntry(model: LlmModel): PiModelEntry {
  const id = model.deployment_name || model.base_name || model.label;
  const classification = classifyPiModel(id);
  const limits = detectLimits(id);

  const entry: PiModelEntry = {
    id,
    name: model.label || id,
    ...(classification.api ? { api: classification.api } : {}),
    ...(isReasoningModel(id) ? { reasoning: true, thinkingLevelMap: defaultThinkingLevelMap() } : {}),
    input: model.multimodal ? ['text', 'image'] : ['text'],
    contextWindow: limits.contextWindow,
    maxTokens: limits.maxTokens,
  };

  if (id.startsWith('claude-sonnet-4-6') || id.startsWith('claude-sonnet-5') || /^claude-opus-4-[6-8]/.test(id) || id.startsWith('claude-opus-5')) {
    entry.compat = { forceAdaptiveThinking: true };
  }

  return entry;
}
```

- [ ] **Step 3: Implement models.json writer**

```typescript
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fetchCodeMieLlmModels } from '../../../providers/plugins/sso/sso.http-client.js';
import { CodeMieSSO } from '../../../providers/plugins/sso/sso.auth.js';
import { logger } from '../../../utils/logger.js';
import { getPiAgentDir, getPiModelsPath } from './pi.paths.js';

interface PiModelsConfig {
  providers: Record<string, {
    baseUrl: string;
    api: string;
    apiKey: string;
    authHeader?: boolean;
    compat?: Record<string, unknown>;
    models: PiModelEntry[];
  }>;
}

async function fetchCodeMieModels(env: NodeJS.ProcessEnv): Promise<LlmModel[]> {
  const jwtToken = env.CODEMIE_JWT_TOKEN;
  const baseUrl = env.CODEMIE_BASE_URL;

  if (jwtToken && baseUrl) {
    logger.debug('[pi-models] Fetching CodeMie model list via JWT auth');
    return fetchCodeMieLlmModels(baseUrl, jwtToken);
  }

  const codeMieUrl = env.CODEMIE_URL;
  if (codeMieUrl) {
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(codeMieUrl);
    if (!credentials) {
      throw new Error(`SSO credentials not found for ${codeMieUrl}. Run: codemie profile login --url ${codeMieUrl}`);
    }
    logger.debug('[pi-models] Fetching CodeMie model list via SSO auth');
    return fetchCodeMieLlmModels(credentials.apiUrl, credentials.cookies);
  }

  throw new Error('No CodeMie authentication available. Run codemie setup or set CODEMIE_JWT_TOKEN.');
}

function buildStaticFallbackModel(modelId: string): PiModelsConfig {
  const classification = classifyPiModel(modelId);
  const entry = convertLlmModelToPiEntry({
    deployment_name: modelId,
    label: modelId,
    enabled: true,
    multimodal: false,
    features: {},
  } as LlmModel);

  return buildModelsConfig([entry], 'http://localhost:0', 'proxy-handled');
}

function buildModelsConfig(
  entries: PiModelEntry[],
  baseUrl: string,
  apiKey: string,
): PiModelsConfig {
  const proxyModels: PiModelEntry[] = [];
  const anthropicModels: PiModelEntry[] = [];

  for (const entry of entries) {
    const classification = classifyPiModel(entry.id);
    if (classification.provider === 'codemie-anthropic') {
      anthropicModels.push(entry);
    } else {
      proxyModels.push(entry);
    }
  }

  const providers: PiModelsConfig['providers'] = {};

  if (proxyModels.length > 0) {
    providers['codemie-proxy'] = {
      baseUrl: `${baseUrl.replace(/\/$/, '')}/v1`,
      api: 'openai-completions',
      apiKey,
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: 'reasoning_effort',
      },
      models: proxyModels,
    };
  }

  if (anthropicModels.length > 0) {
    providers['codemie-anthropic'] = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      api: 'anthropic-messages',
      apiKey,
      authHeader: true,
      compat: {
        supportsReasoningEffort: true,
        thinkingFormat: 'reasoning_effort',
      },
      models: anthropicModels,
    };
  }

  return { providers };
}

export async function fetchAndBuildPiModels(
  env: NodeJS.ProcessEnv,
  cwd: string = process.cwd(),
): Promise<void> {
  const agentDir = getPiAgentDir(cwd);
  await mkdir(agentDir, { recursive: true });

  const baseUrl = env.CODEMIE_BASE_URL || '';
  const apiKey = env.CODEMIE_API_KEY || 'proxy-handled';

  let entries: PiModelEntry[] = [];
  try {
    const rawModels = await fetchCodeMieModels(env);
    entries = rawModels
      .filter(model => model.enabled)
      .map(convertLlmModelToPiEntry);
    logger.debug(`[pi-models] Loaded ${entries.length} models from CodeMie API`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[pi-models] Failed to fetch live models, falling back to static model: ${message}`);
    const configuredModel = env.CODEMIE_MODEL;
    if (!configuredModel) {
      throw new Error('No CodeMie model configured and live model fetch failed.');
    }
    const fallback = buildStaticFallbackModel(configuredModel);
    await writeFile(getPiModelsPath(cwd), JSON.stringify(fallback, null, 2), 'utf-8');
    return;
  }

  if (entries.length === 0) {
    throw new Error('CodeMie returned no enabled models for codemie-pi.');
  }

  const config = buildModelsConfig(entries, baseUrl, apiKey);
  await writeFile(getPiModelsPath(cwd), JSON.stringify(config, null, 2), 'utf-8');
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`  
Expected: No errors.

---

## Task 3: Pi agent directory preparation helper

**Files:**
- Create: `src/agents/plugins/pi/pi.setup.ts`

**Interfaces:**
- Consumes: `getUserPiAgentDir()`, `getPiAgentDir()` from `pi.paths.ts`.
- Produces: `preparePiAgentDir(cwd?: string): Promise<void>` — copies `~/.pi/agent` to the CodeMie-managed directory only on first run.

- [ ] **Step 1: Implement directory copy helper**

```typescript
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { cp } from 'fs/promises';
import { logger } from '../../../utils/logger.js';
import { getPiAgentDir, getUserPiAgentDir } from './pi.paths.js';

export async function preparePiAgentDir(cwd: string = process.cwd()): Promise<void> {
  const sourceDir = getUserPiAgentDir();
  const destDir = getPiAgentDir(cwd);

  if (existsSync(destDir)) {
    logger.debug(`[pi-setup] CodeMie Pi agent dir already exists, skipping copy: ${destDir}`);
    return;
  }

  if (!existsSync(sourceDir)) {
    logger.warn(`[pi-setup] User Pi agent dir not found, starting fresh: ${sourceDir}`);
    await mkdir(destDir, { recursive: true });
    return;
  }

  logger.debug(`[pi-setup] Copying ${sourceDir} → ${destDir}`);
  await cp(sourceDir, destDir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`  
Expected: No errors.

---

## Task 4: Pi plugin

**Files:**
- Create: `src/agents/plugins/pi/pi.plugin.ts`

**Interfaces:**
- Consumes: `preparePiAgentDir()` from `pi.setup.ts`.
- Consumes: `fetchAndBuildPiModels()` from `pi.models.ts`.
- Produces: `PiPluginMetadata: AgentMetadata`.
- Produces: `PiPlugin extends BaseAgentAdapter`.

- [ ] **Step 1: Implement plugin metadata and class**

```typescript
import type { AgentMetadata, AgentConfig } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import { logger } from '../../../utils/logger.js';
import { preparePiAgentDir } from './pi.setup.js';
import { fetchAndBuildPiModels, classifyPiModel } from './pi.models.js';
import { getPiAgentDir } from './pi.paths.js';

export const PiPluginMetadata: AgentMetadata = {
  name: 'pi',
  displayName: 'Pi',
  description: 'Pi - open-source coding agent harness',
  npmPackage: '@earendil-works/pi-coding-agent',
  cliCommand: process.env.CODEMIE_PI_BIN || 'pi',

  sessionAnalyticsReport: false,

  dataPaths: {
    home: '.pi',
  },

  envMapping: {
    baseUrl: [],
    apiKey: [],
    model: [],
  },

  supportedProviders: ['ai-run-sso', 'bearer-auth', 'litellm'],

  ssoConfig: {
    enabled: true,
    clientType: 'codemie-pi',
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      const cwd = process.cwd();
      await preparePiAgentDir(cwd);
      await fetchAndBuildPiModels(env, cwd);
      env.PI_CODING_AGENT_DIR = getPiAgentDir(cwd);
      logger.debug('[pi] Configured PI_CODING_AGENT_DIR', { path: env.PI_CODING_AGENT_DIR });
      return env;
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      const model = process.env.CODEMIE_MODEL;
      if (!model) {
        throw new Error('No model configured for codemie-pi. Run codemie setup to select a model.');
      }

      const classification = classifyPiModel(model);
      const providerId = classification.provider;

      let result = args;

      const taskIndex = result.indexOf('--task');
      if (taskIndex !== -1 && taskIndex < result.length - 1) {
        const taskValue = result[taskIndex + 1];
        result = [...result.slice(0, taskIndex), ...result.slice(taskIndex + 2), taskValue];
      }

      return ['--provider', providerId, '--model', model, ...result];
    },
  },
};

export class PiPlugin extends BaseAgentAdapter {
  constructor() {
    super(PiPluginMetadata);
  }
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`  
Expected: No errors.

---

## Task 5: Plugin index

**Files:**
- Create: `src/agents/plugins/pi/index.ts`

- [ ] **Step 1: Re-export plugin**

```typescript
export { PiPlugin, PiPluginMetadata } from './pi.plugin.js';
```

---

## Task 6: CLI entry point

**Files:**
- Create: `bin/codemie-pi.js`

- [ ] **Step 1: Add entry point**

```javascript
#!/usr/bin/env node

/**
 * Pi Agent Entry Point
 * Direct entry point for codemie-pi command
 */

import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';

const agent = AgentRegistry.getAgent('pi');
if (!agent) {
  console.error('✗ Pi agent not found in registry');
  process.exit(1);
}

const cli = new AgentCLI(agent);
await cli.run(process.argv);
```

- [ ] **Step 2: Make file executable**

Run: `chmod +x bin/codemie-pi.js`

---

## Task 7: Register plugin

**Files:**
- Modify: `src/agents/registry.ts`

- [ ] **Step 1: Import and register PiPlugin**

Add near the top with other plugin imports:

```typescript
import { PiPlugin } from './plugins/pi/index.js';
```

Add in `AgentRegistry.initialize()` before `AgentRegistry.initialized = true;`:

```typescript
AgentRegistry.registerPlugin(new PiPlugin());
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`  
Expected: No errors.

---

## Task 8: Add npm bin entry

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add codemie-pi bin**

In the `bin` object, add:

```json
"codemie-pi": "./bin/codemie-pi.js"
```

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json valid')"`  
Expected: Prints `package.json valid`.

---

## Task 9: Build and final verification

- [ ] **Step 1: Install dependencies**

Run: `npm install`  
Expected: Completes without errors.

- [ ] **Step 2: Build**

Run: `npm run build`  
Expected: TypeScript compiles successfully; `dist/agents/plugins/pi/` and `dist/agents/registry.js` exist.

- [ ] **Step 3: Lint**

Run: `npm run lint`  
Expected: Zero warnings/errors.

- [ ] **Step 4: Manual smoke test**

Run: `codemie install pi` then `codemie-pi --task "hello"` in a test project.  
Expected:
- `<cwd>/.pi/codemie/agent/models.json` exists.
- The file contains `codemie-proxy` and/or `codemie-anthropic` providers.
- The `baseUrl` values point to the local CodeMie proxy.
- Pi starts and routes chat through the selected model.

---

## Self-review

**Spec coverage:**
- npm global install of upstream Pi → covered by `AgentMetadata.npmPackage`.
- `PI_CODING_AGENT_DIR` set to cwd-relative dir → covered in `beforeRun`.
- Copy `~/.pi/agent` on first run → covered in `preparePiAgentDir`.
- Live model fetch and `models.json` generation → covered in `pi.models.ts`.
- `--provider`/`--model` injection → covered in `enrichArgs`.
- Session analytics out of scope → `sessionAnalyticsReport: false`.

**Placeholder scan:** No TBD/TODO/fill-in-details. All functions include concrete code.

**Type consistency:**
- `getPiAgentDir(cwd?: string): string` used consistently.
- `classifyPiModel(modelId: string): PiModelClassification` used in both `pi.models.ts` and `pi.plugin.ts`.
- `AgentMetadata.lifecycle.beforeRun` signature matches the interface.
