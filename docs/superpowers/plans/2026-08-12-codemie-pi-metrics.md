# codemie-pi metrics parity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `PiSessionAdapter` + `PiMetricsProcessor` and wire lifecycle hooks into the existing `codemie-pi` plugin so running `codemie pi` produces the same lifecycle and tool-usage metrics as `codemie-claude`.

**Architecture:** Post-hoc parsing of Pi’s JSONL session file after `pi` exits; reuse the existing `hook.ts` → `SessionAdapter` → `MetricsSyncProcessor` pipeline. No upstream Pi changes.

> **Historical artifact notice.** This plan was written before implementation and multiple rounds of review. Its inline code blocks show the original intended shape and **do not match the shipped implementation**. The current source of truth is the design spec (`docs/superpowers/specs/2026-08-12-codemie-pi-metrics-design.md`) and the actual source files in `src/agents/plugins/pi/`. In particular, the plan predates the header-driven discovery, LIFO tool-call pairing, skill-wrapper stripping, and verbatim tool-name handling that the remediated code now uses.

**Tech Stack:** TypeScript, ES modules, Node.js `fs/promises`, existing `MetricsWriter`, `BaseSessionAdapter`, `BaseProcessor`.

## Global Constraints

- Node.js >= 20.0.0.
- ES modules only; every import must include `.js` extension.
- No `any` on exported APIs; use explicit types.
- Tests are only written if explicitly requested; do not add tests otherwise.
- Metrics failures must be non-blocking for the user / Pi exit.
- Branch: `feat/codemie-pi-metrics-parity`.
- Follow the `codemie-opencode` post-hoc parity pattern and `codemie-claude` metrics processor patterns.

## File structure

| File | Responsibility |
|---|---|
| `src/agents/plugins/pi/pi.paths.ts` (modify) | Add Pi session-directory helper using Pi’s `--<cwd-escaped>--` encoding. |
| `src/agents/plugins/pi/pi.types.ts` (create) | Local TypeScript shapes for Pi session JSONL entries (`message`, `model_change`, etc.). |
| `src/agents/plugins/pi/session/pi-file-operations.ts` (create) | Map Pi tool names + arguments/results to `FileOperation` records with line counts. |
| `src/agents/plugins/pi/session/processors/pi.metrics-processor.ts` (create) | Translate Pi `message` entries into `MetricDelta` JSONL records. |
| `src/agents/plugins/pi/pi.session.ts` (create) | `PiSessionAdapter`: discover, parse, and process Pi session files. |
| `src/agents/plugins/pi/pi.plugin.ts` (modify) | Add `onSessionStart`/`onSessionEnd`, `getSessionAdapter()`, `metricsConfig`, `sessionAnalyticsReport: true`. |
| `src/agents/plugins/pi/index.ts` (modify) | Re-export `PiSessionAdapter` if useful. |

---

### Task 1: Add Pi session directory path helper

**Files:**
- Modify: `src/agents/plugins/pi/pi.paths.ts`

**Interfaces:**
- Consumes: `getPiAgentDir(cwd)` (already exists).
- Produces: `getPiSessionDir(cwd: string): string` returning the directory that contains Pi JSONL session files for the current cwd.

Pi encodes the cwd as a directory name: `--<cwd with leading slash removed and `/`, `\`, `:` replaced by `-`>--`.

- [ ] **Step 1: Add helper function**

```typescript
export function getPiSessionDir(cwd: string = process.cwd()): string {
  const resolved = resolve(cwd); // import resolve from 'path'
  const safeName = `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getPiAgentDir(cwd), 'sessions', safeName);
}
```

- [ ] **Step 2: Run typecheck for the file**

Run: `npx tsc --noEmit src/agents/plugins/pi/pi.paths.ts` (or `npm run typecheck` if preferred)
Expected: No errors.

---

### Task 2: Add local Pi session entry types

**Files:**
- Create: `src/agents/plugins/pi/pi.types.ts`

**Interfaces:**
- Produces: `PiEntry`, `PiMessageEntry`, `PiUserMessage`, `PiAssistantMessage`, `PiToolResultMessage`, `PiModelChangeEntry`, `isPiMessageEntry`, `isPiUserMessage`, `isPiAssistantMessage`, `isPiToolResultMessage`.

These are local, best-effort shapes based on Pi’s `packages/ai/src/types.ts` and `packages/agent/src/harness/session/types.ts`. Pi is not added as a dependency.

- [ ] **Step 1: Write the types file**

```typescript
export interface PiEntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

export interface PiToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiUserMessage {
  role: 'user';
  content: string | (PiTextContent | unknown)[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: 'assistant';
  content: (PiTextContent | PiToolCall | unknown)[];
  model?: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | unknown)[] | unknown;
  details?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  isError?: boolean;
  timestamp: number;
}

export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export interface PiMessageEntry extends PiEntryBase {
  type: 'message';
  message: PiAgentMessage;
}

export interface PiModelChangeEntry extends PiEntryBase {
  type: 'model_change';
  modelId: string;
}

export type PiEntry = PiMessageEntry | PiModelChangeEntry | PiEntryBase;

export function isPiMessageEntry(entry: PiEntry): entry is PiMessageEntry {
  return entry.type === 'message' && entry.message !== undefined;
}

export function isPiUserMessage(message: PiAgentMessage): message is PiUserMessage {
  return message.role === 'user';
}

export function isPiAssistantMessage(message: PiAgentMessage): message is PiAssistantMessage {
  return message.role === 'assistant';
}

export function isPiToolResultMessage(message: PiAgentMessage): message is PiToolResultMessage {
  return message.role === 'toolResult';
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 3: Implement file-operation extraction

**Files:**
- Create: `src/agents/plugins/pi/session/pi-file-operations.ts`

**Interfaces:**
- Consumes: `PiToolCall` (from `pi.types.ts`) and `PiToolResultMessage.details`.
- Produces: `extractPiFileOperation(toolName, arguments, details) -> FileOperation | undefined` and `countPiDiffLines(patch) -> { linesAdded, linesRemoved }`.

- [ ] **Step 1: Write the file**

```typescript
import type { FileOperation, FileOperationType } from '../../../core/metrics/types.js';
import { extractFormat, detectLanguage } from '../../../utils/file-operations.js';

export interface PiFileOperation extends FileOperation {}

const TOOL_TYPE_MAP: Record<string, FileOperationType> = {
  write: 'write',
  edit: 'edit',
  read: 'read',
  grep: 'grep',
  glob: 'glob',
  ls: 'read',
  find: 'glob',
};

export function countPiDiffLines(patch: unknown): { linesAdded: number; linesRemoved: number } {
  if (typeof patch !== 'string' || patch.length === 0) {
    return { linesAdded: 0, linesRemoved: 0 };
  }

  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }

  return { linesAdded, linesRemoved };
}

function extractPath(args?: Record<string, unknown>, details?: Record<string, unknown>): string | undefined {
  const fromArgs = args?.path ?? args?.filePath ?? args?.file_path;
  if (typeof fromArgs === 'string') return fromArgs;
  const fromDetails = details?.path ?? details?.filePath ?? details?.file_path;
  if (typeof fromDetails === 'string') return fromDetails;
  return undefined;
}

export function extractPiFileOperation(
  toolName: string,
  toolArguments?: Record<string, unknown>,
  toolResultDetails?: Record<string, unknown>
): PiFileOperation | undefined {
  const type = TOOL_TYPE_MAP[toolName.toLowerCase()];
  if (!type) return undefined;

  const operation: PiFileOperation = { type };

  const filePath = extractPath(toolArguments, toolResultDetails);
  if (filePath) {
    operation.path = filePath;
    operation.format = extractFormat(filePath);
    operation.language = detectLanguage(filePath);
  }

  if (typeof toolArguments?.pattern === 'string') {
    operation.pattern = toolArguments.pattern;
  }

  if (toolName.toLowerCase() === 'write') {
    const content = toolArguments?.content;
    if (typeof content === 'string' && content.length > 0) {
      operation.linesAdded = content.split('\n').length;
    }
  }

  if (toolName.toLowerCase() === 'edit') {
    const patch = toolResultDetails?.diff ?? toolResultDetails?.patch;
    const { linesAdded, linesRemoved } = countPiDiffLines(patch);
    if (linesAdded > 0) operation.linesAdded = linesAdded;
    if (linesRemoved > 0) operation.linesRemoved = linesRemoved;
  }

  return operation;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 4: Implement Pi metrics processor

**Files:**
- Create: `src/agents/plugins/pi/session/processors/pi.metrics-processor.ts`

**Interfaces:**
- Consumes: `ParsedSession` with `messages: PiEntry[]` and `metadata.gitBranch`; `ProcessingContext`.
- Produces: `PiMetricsProcessor implements SessionProcessor` with `name = 'pi-metrics'`, `priority = 1`.

One delta per user prompt, one delta per assistant tool call, and one delta per assistant-level API error so that later incremental ticks (if added in future) stay idempotent.

- [ ] **Step 1: Write the processor**

```typescript
import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';
import type { MetricDelta } from '../../../../core/metrics/types.js';
import { logger } from '../../../../../utils/logger.js';
import {
  isPiMessageEntry,
  isPiUserMessage,
  isPiAssistantMessage,
  isPiToolResultMessage,
  type PiEntry,
  type PiAssistantMessage,
  type PiToolCall,
  type PiToolResultMessage,
} from '../../pi.types.js';
import { extractPiFileOperation } from '../pi-file-operations.js';

const PI_METRICS_PROCESSOR_NAME = 'pi-metrics';

type PendingDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;

export class PiMetricsProcessor implements SessionProcessor {
  readonly name = PI_METRICS_PROCESSOR_NAME;
  readonly priority = 1;

  shouldProcess(session: ParsedSession): boolean {
    return session.messages.length > 0;
  }

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessingResult> {
    try {
      const entries = session.messages as PiEntry[];
      const existingRecordIds = await this.getExistingRecordIds(session.sessionId);
      const gitBranch = context.gitBranch;

      const toolResultByToolCallId = new Map<string, PiToolResultMessage>();
      for (const entry of entries) {
        if (isPiMessageEntry(entry) && isPiToolResultMessage(entry.message)) {
          toolResultByToolCallId.set(entry.message.toolCallId, entry.message);
        }
      }

      const deltas: PendingDelta[] = [];
      let skippedDueToDedup = 0;

      const base = (recordId: string, timestamp: number): PendingDelta => ({
        recordId,
        sessionId: session.sessionId,
        agentSessionId: context.sessionId ?? session.sessionId,
        timestamp,
        ...(gitBranch && { gitBranch }),
      });

      for (const entry of entries) {
        if (!isPiMessageEntry(entry)) continue;

        const msg = entry.message;

        if (isPiUserMessage(msg)) {
          const text = this.extractUserText(msg);
          if (!text) continue;
          const recordId = `${entry.id}:prompt`;
          if (existingRecordIds.has(recordId)) {
            skippedDueToDedup++;
            continue;
          }
          deltas.push({ ...base(recordId, msg.timestamp), userPrompts: [{ count: 1, text }] });
          continue;
        }

        if (isPiAssistantMessage(msg)) {
          const toolCalls = this.extractToolCalls(msg);

          for (const toolCall of toolCalls) {
            const recordId = `${entry.id}:${toolCall.id}`;
            if (existingRecordIds.has(recordId)) {
              skippedDueToDedup++;
              continue;
            }

            const result = toolResultByToolCallId.get(toolCall.id);
            const toolName = toolCall.name.toLowerCase();
            const isFailure = result?.isError === true;
            const fileOps = !isFailure
              ? this.extractFileOperations(toolCall, result).filter((op): op is NonNullable<typeof op> => op !== undefined)
              : [];

            const delta: PendingDelta = {
              ...base(recordId, msg.timestamp),
              tools: { [toolName]: 1 },
              toolStatus: {
                [toolName]: {
                  success: isFailure ? 0 : 1,
                  failure: isFailure ? 1 : 0,
                },
              },
              ...(fileOps.length > 0 && { fileOperations: fileOps }),
              ...(msg.model && { models: [msg.model] }),
            };

            deltas.push(delta);
          }

          if (msg.errorMessage) {
            const recordId = `${entry.id}:error`;
            if (!existingRecordIds.has(recordId)) {
              deltas.push({
                ...base(recordId, msg.timestamp),
                apiErrorMessage: msg.errorMessage,
                ...(msg.model && { models: [msg.model] }),
              });
            } else {
              skippedDueToDedup++;
            }
          }
        }
      }

      if (deltas.length === 0) {
        return {
          success: true,
          message: `No new deltas (${skippedDueToDedup} already processed)`,
          metadata: { recordsProcessed: entries.length, deltasWritten: 0, deltasSkipped: skippedDueToDedup },
        };
      }

      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(session.sessionId);
      for (const delta of deltas) {
        await writer.appendDelta(delta);
      }

      return {
        success: true,
        message: `Generated ${deltas.length} deltas`,
        metadata: { recordsProcessed: entries.length, deltasWritten: deltas.length, deltasSkipped: skippedDueToDedup },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[pi-metrics] Processing failed:`, error);
      return { success: false, message: `Metrics processing failed: ${msg}`, metadata: { failureReason: 'PROCESSING_ERROR' } };
    }
  }

  private extractUserText(msg: { content: string | unknown[] }): string | undefined {
    if (typeof msg.content === 'string') return msg.content.trim() || undefined;
    const textParts = (msg.content as unknown[])
      .filter((part): part is { type: string; text?: string } => typeof part === 'object' && part !== null)
      .map(part => part.text)
      .filter((text): text is string => typeof text === 'string' && text.trim().length > 0);
    return textParts.length > 0 ? textParts.join('\n') : undefined;
  }

  private extractToolCalls(msg: PiAssistantMessage): PiToolCall[] {
    if (!Array.isArray(msg.content)) return [];
    return msg.content.filter((part): part is PiToolCall =>
      typeof part === 'object' && part !== null && (part as PiToolCall).type === 'toolCall'
    );
  }

  private extractFileOperations(
    toolCall: PiToolCall,
    result?: PiToolResultMessage
  ): (ReturnType<typeof extractPiFileOperation>)[] {
    const op = extractPiFileOperation(toolCall.name, toolCall.arguments, result?.details);
    return op ? [op] : [];
  }

  private async getExistingRecordIds(sessionId: string): Promise<Set<string>> {
    try {
      const { MetricsWriter } = await import('../../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
      const writer = new MetricsWriter(sessionId);
      if (!writer.exists()) return new Set();
      const existing = await writer.readAll();
      return new Set(existing.map(d => d.recordId));
    } catch (error) {
      logger.warn('[pi-metrics] Could not read existing deltas:', error);
      return new Set();
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 5: Implement Pi session adapter

**Files:**
- Create: `src/agents/plugins/pi/pi.session.ts`

**Interfaces:**
- Consumes: `AgentMetadata`, `SessionDiscoveryOptions`, `ProcessingContext`.
- Produces: `PiSessionAdapter implements SessionAdapter` with `discoverSessions`, `parseSessionFile`, `processSession`, `registerProcessor`.

- [ ] **Step 1: Write the adapter**

```typescript
import { readFile, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import type { SessionAdapter, ParsedSession, AggregatedResult, SessionDiscoveryOptions, SessionDescriptor } from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { logger } from '../../../utils/logger.js';
import { getPiSessionDir } from './pi.paths.js';
import { PiMetricsProcessor } from './session/processors/pi.metrics-processor.js';
import type { PiEntry } from './pi.types.js';

export class PiSessionAdapter implements SessionAdapter {
  readonly agentName = 'pi';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {
    this.initializeProcessors();
  }

  private initializeProcessors(): void {
    this.registerProcessor(new PiMetricsProcessor());
    logger.debug(`[pi-adapter] Initialized ${this.processors.length} processors`);
  }

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[pi-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    try {
      const entries = await this.readJsonlFile(filePath);
      const projectPath = process.cwd();

      return {
        sessionId,
        agentName: this.metadata.displayName || 'Pi',
        metadata: { projectPath },
        messages: entries as unknown[],
      };
    } catch (error) {
      logger.error(`[pi-adapter] Failed to parse session file ${filePath}:`, error);
      throw error;
    }
  }

  private async readJsonlFile(filePath: string): Promise<PiEntry[]> {
    const content = await readFile(filePath, 'utf-8');
    const entries: PiEntry[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as PiEntry);
      } catch {
        logger.debug(`[pi-adapter] Skipping malformed JSONL line in ${filePath}`);
      }
    }
    return entries;
  }

  async processSession(filePath: string, sessionId: string, context: ProcessingContext): Promise<AggregatedResult> {
    const parsedSession = await this.parseSessionFile(filePath, sessionId);
    if (context.gitBranch && parsedSession.metadata) {
      (parsedSession.metadata as Record<string, unknown>).gitBranch = context.gitBranch;
    }

    const processorResults: Record<string, { success: boolean; message?: string; recordsProcessed?: number }> = {};
    const failedProcessors: string[] = [];
    let totalRecords = 0;

    for (const processor of this.processors) {
      try {
        if (!processor.shouldProcess(parsedSession)) {
          logger.debug(`[pi-adapter] Processor ${processor.name} skipped`);
          continue;
        }
        const result = await processor.process(parsedSession, context);
        processorResults[processor.name] = {
          success: result.success,
          message: result.message,
          recordsProcessed: result.metadata?.recordsProcessed,
        };
        if (!result.success) {
          failedProcessors.push(processor.name);
        }
        if (typeof result.metadata?.recordsProcessed === 'number') {
          totalRecords += result.metadata.recordsProcessed;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        logger.error(`[pi-adapter] Processor ${processor.name} threw:`, error);
        processorResults[processor.name] = { success: false, message: msg };
        failedProcessors.push(processor.name);
      }
    }

    return {
      success: failedProcessors.length === 0,
      processors: processorResults,
      totalRecords,
      failedProcessors,
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const sessionDir = getPiSessionDir(options?.cwd ?? process.cwd());
    if (!existsSync(sessionDir)) {
      logger.debug(`[pi-discovery] Pi session directory does not exist: ${sessionDir}`);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? 30;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const results: SessionDescriptor[] = [];

    try {
      const files = await readdir(sessionDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(sessionDir, file);
        const statResult = await stat(filePath);
        if (!statResult.isFile()) continue;

        const match = file.match(/^(\d+)_(.+?)\.jsonl$/);
        if (!match) continue;
        const createdAt = parseInt(match[1], 10);
        const sessionId = match[2];
        if (Number.isNaN(createdAt) || createdAt < cutoff) continue;

        results.push({
          sessionId,
          filePath,
          projectPath: options?.cwd,
          createdAt,
          updatedAt: statResult.mtime.getTime(),
          agentName: 'pi',
        });
      }
    } catch (error) {
      logger.debug(`[pi-discovery] Failed to scan session dir ${sessionDir}:`, error);
      return [];
    }

    results.sort((a, b) => b.createdAt - a.createdAt);
    const limited = options?.limit && options.limit > 0 ? results.slice(0, options.limit) : results;
    logger.debug(`[pi-discovery] Found ${results.length} Pi sessions, returning ${limited.length}`);
    return limited;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 6: Wire lifecycle hooks and metadata in Pi plugin

**Files:**
- Modify: `src/agents/plugins/pi/pi.plugin.ts`

**Interfaces:**
- Consumes: `PiSessionAdapter`, `processEvent` from `hook.ts`.
- Produces: `onSessionStart`, `onSessionEnd`, `getSessionAdapter`, updated `PiPluginMetadata`.

- [ ] **Step 1: Update imports and metadata**

Add these imports at the top of `src/agents/plugins/pi/pi.plugin.ts`:

```typescript
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { PiSessionAdapter } from './pi.session.js';
import type { HookProcessingConfig } from '../../../cli/commands/hook.js';
```

Update `PiPluginMetadata`:

```typescript
export const PiPluginMetadata: AgentMetadata = {
  // ... existing identity/installation fields ...

  sessionAnalyticsReport: true,

  metricsConfig: {
    excludeErrorsFromTools: ['bash'],
  },

  lifecycle: {
    async beforeRun(env: NodeJS.ProcessEnv, _config: AgentConfig) {
      // existing implementation
    },

    enrichArgs(args: string[], _config: AgentConfig): string[] {
      // existing implementation
    },

    async onSessionStart(sessionId: string, env: NodeJS.ProcessEnv) {
      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionStart',
            session_id: sessionId,
            transcript_path: '',
            permission_mode: 'default',
            cwd: process.cwd(),
            source: 'startup',
          },
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionStart hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionStart hook failed (non-blocking): ${msg}`);
      }
    },

    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      const sessionId = env.CODEMIE_SESSION_ID;
      if (!sessionId) {
        logger.debug('[pi] No CODEMIE_SESSION_ID in environment, skipping session end');
        return;
      }

      let transcriptPath = '';
      try {
        const adapter = new PiSessionAdapter(PiPluginMetadata);
        const sessions = await adapter.discoverSessions({ maxAgeDays: 1, limit: 1, cwd: process.cwd() });
        if (sessions.length > 0) {
          transcriptPath = sessions[0].filePath;
          logger.debug(`[pi] Discovered Pi session: ${sessions[0].sessionId}`);
        } else {
          logger.debug('[pi] No recent Pi sessions found for this directory');
        }
      } catch (discoverError) {
        const msg = discoverError instanceof Error ? discoverError.message : String(discoverError);
        logger.debug(`[pi] Session discovery failed (non-blocking): ${msg}`);
      }

      try {
        const { processEvent } = await import('../../../cli/commands/hook.js');
        await processEvent(
          {
            hook_event_name: 'SessionEnd',
            session_id: sessionId,
            transcript_path: transcriptPath,
            permission_mode: 'default',
            cwd: process.cwd(),
            reason: exitCode === 0 ? 'exit' : `exit(${exitCode})`,
          },
          buildPiHookConfig(env, sessionId)
        );
        logger.info(`[pi] SessionEnd hook completed for session ${sessionId}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[pi] SessionEnd hook failed (non-blocking): ${msg}`);
      }
    },
  },
};
```

Add `buildPiHookConfig` above the metadata:

```typescript
function buildPiHookConfig(env: NodeJS.ProcessEnv, sessionId: string): HookProcessingConfig {
  return {
    agentName: env.CODEMIE_AGENT || 'pi',
    sessionId,
    provider: env.CODEMIE_PROVIDER,
    apiBaseUrl: env.CODEMIE_BASE_URL,
    ssoUrl: env.CODEMIE_URL,
    version: env.CODEMIE_CLI_VERSION,
    profileName: env.CODEMIE_PROFILE_NAME,
    project: env.CODEMIE_PROJECT,
    model: env.CODEMIE_MODEL,
    clientType: 'codemie-pi',
  };
}
```

- [ ] **Step 2: Update the plugin class**

```typescript
export class PiPlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(PiPluginMetadata);
    this.sessionAdapter = new PiSessionAdapter(PiPluginMetadata);
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }

  async additionalInstallation(
    _options?: import('../../core/types.js').AgentInstallationOptions,
  ): Promise<void> {
    await installRequiredPiPackages({ cliCommand: this.metadata.cliCommand });
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 7: Update index exports

**Files:**
- Modify: `src/agents/plugins/pi/index.ts`

**Interfaces:**
- Produces: re-exports of `PiSessionAdapter` and new types.

- [ ] **Step 1: Add exports**

```typescript
export { PiPlugin, PiPluginMetadata } from './pi.plugin.js';
export { PiSessionAdapter } from './pi.session.js';
```

No new symbols are strictly required to be public; only add `PiSessionAdapter` for consistency with other agents.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: No errors.

---

### Task 8: Full build and lint

**Files:**
- All of the above.

- [ ] **Step 1: Run lint**

Run: `npm run lint`
Expected: No warnings/errors.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds.

---

## Self-review checklist

- Spec coverage: every row in the metrics parity table is implemented by a combination of `PiMetricsProcessor` and the lifecycle hooks.
- Placeholder scan: no TODO/TBD; every step contains concrete code.
- Type consistency: `PiEntry`, `PiToolCall`, and `FileOperation` types are used consistently across files.
- Non-blocking error handling: all `onSessionStart`/`onSessionEnd`/processor paths catch and log errors.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-12-codemie-pi-metrics.md`.

Recommended next step: dispatch subagents via `superpowers:subagent-driven-development`, one task per subagent, with review between tasks.

