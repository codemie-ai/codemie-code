# GitHub Copilot CLI Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub Copilot CLI sessions appear in `codemie analytics` as a first-class agent — discovered from local disk, priced from the existing pricing table, and visible in the report with its own color and label.

**Architecture:** A new analytics-only agent plugin (`copilot-cli`) registers a `SessionAdapter` that discovers sessions from `~/.copilot/session-state/*/workspace.yaml` and parses `events.jsonl` into the unified `ParsedSession`. A new usage reader decomposes Copilot's OpenAI-convention token buckets into the repo's Anthropic-convention `TokenUsage`. Three analytics touch-points (native discovery list, ownership exemption, usage-reader wiring) plus an additive report-payload field and a new client-side label map complete the integration.

**Tech Stack:** TypeScript (ESM), Node ≥ 20, Vitest, npm. `yaml` ^2.8.3 (already a dependency, used by `src/utils/frontmatter.ts`).

## Global Constraints

- All relative imports MUST carry the `.js` extension (ESM). Example: `import { logger } from '../../../utils/logger.js';`
- Prefer the `@/` alias over deep relative paths (`../../..`).
- No `any`. `interface` for object shapes. Explicit return types on exported functions.
- Never `console.log` — use `logger.debug()` / `logger.warn()` from `src/utils/logger.ts`.
- Never construct `~/.codemie` paths by hand — use `getCodemiePath()` from `src/utils/paths.ts`.
- Internal agent key is exactly `copilot-cli`. User-facing label is exactly `GitHub Copilot CLI`.
- Parsing is defensive everywhere: drop unparseable JSONL lines, never throw out of discovery or parsing.
- Token math: `input` is billed at full rate **in addition to** `cacheRead` by `cost-calculator.ts:51`. Copilot's `inputTokens` is **inclusive** of `cacheReadTokens`. Never populate `TokenUsage.input` with a raw Copilot `inputTokens`.

## ⚠️ Testing policy tension — read before starting

This repo's `AGENTS.md` states tests are written **only on explicit user request**. The SDLC flow's implementation stage is TDD, and every task below carries a `Test-first:` line describing the intended failing test.

**These two rules conflict.** Resolve it with the user before Task 1 rather than silently picking one:

- If the user wants tests: execute each task exactly as written (RED → GREEN → commit).
- If the user does not want tests: skip the test steps, implement the production code, and verify each task via its stated manual check. The `Test-first:` lines then serve as documentation of what *should* be covered later.

Tasks 4 and 8 guard the two failure modes that would ship a silently-broken feature. If tests are skipped everywhere else, these two are the ones worth arguing for.

---

## File Structure

**New — `src/agents/plugins/copilot-cli/`**

| File | Responsibility |
|---|---|
| `index.ts` | Barrel export of `CopilotCliPlugin` |
| `copilot-cli.paths.ts` | Resolve `COPILOT_HOME` / `~/.copilot`; locate `session-state/` |
| `copilot-cli-event-types.ts` | TypeScript shapes for `events.jsonl` events and `workspace.yaml` |
| `copilot-cli.workspace.ts` | Read + parse one `workspace.yaml` into a manifest |
| `copilot-cli.storage-utils.ts` | Tolerant JSONL reader |
| `copilot-cli.usage.ts` | Extract per-model raw token buckets from events (tier 1 / tier 2 / tier 3) |
| `copilot-cli.session.ts` | `SessionAdapter`: `discoverSessions`, `parseSessionFile`, processor plumbing |
| `copilot-cli.plugin.ts` | Minimal `BaseAgentAdapter` subclass + `AgentMetadata` |
| `session/processors/copilot-cli.metrics-processor.ts` | Metrics processor registration |
| `session/processors/copilot-cli.conversations-processor.ts` | Conversations processor registration |

**Modified**

| File | Change |
|---|---|
| `src/agents/registry.ts:32-39` | Register `CopilotCliPlugin` |
| `src/cli/commands/analytics/native-loader.ts:31` | Add `'copilot-cli'` to `NATIVE_AGENTS` |
| `src/cli/commands/analytics/native-loader.ts:518` | Ownership-gate exemption for analytics-only agents |
| `src/cli/commands/analytics/cost/usage-readers.ts` | `readCopilotCli` + two dispatch branches |
| `src/cli/commands/analytics/report/types.ts` | Optional Copilot fields on `ReportSessionRecord` |
| `src/cli/commands/analytics/report/payload-builder.ts:59` | Populate those fields |
| `src/cli/commands/analytics/report/client/app.js:22` | `AGENT_COLORS` + new `AGENT_LABELS` / `labelFor()` |
| `src/cli/commands/analytics/formatter.ts` | Use the label in terminal output |

---

## Task 1: Paths, event types, and the workspace.yaml manifest reader

**Files:**
- Create: `src/agents/plugins/copilot-cli/copilot-cli.paths.ts`
- Create: `src/agents/plugins/copilot-cli/copilot-cli-event-types.ts`
- Create: `src/agents/plugins/copilot-cli/copilot-cli.workspace.ts`
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.workspace.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `getCopilotHome(): string`, `getCopilotSessionStateRoot(): string`, `readWorkspaceManifest(dir: string): CopilotWorkspaceManifest | null`, and the event-type interfaces every later task imports.

**Test-first: yes** — `readWorkspaceManifest` returns `null` for a directory with no `workspace.yaml`, and parses a real fixture into `{ id, cwd, gitRoot, repository, branch, createdAt, updatedAt, name }` with `createdAt` as epoch ms.

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.workspace.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceManifest } from '../copilot-cli.workspace.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-ws-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readWorkspaceManifest', () => {
  it('returns null when workspace.yaml is absent', () => {
    const dir = join(root, 'no-manifest');
    mkdirSync(dir);
    expect(readWorkspaceManifest(dir)).toBeNull();
  });

  it('parses a full manifest into epoch-ms timestamps', () => {
    const dir = join(root, '879c0438-dace-429f-b4db-450aae9bde54');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'workspace.yaml'),
      [
        'id: 879c0438-dace-429f-b4db-450aae9bde54',
        'cwd: /Users/x/repo',
        'git_root: /Users/x/repo',
        'repository: codemie-ai/codemie-code',
        'host_type: github',
        'branch: fix/analytics',
        'user_named: false',
        'summary_count: 0',
        'created_at: 2026-06-16T06:21:01.974Z',
        'updated_at: 2026-06-16T06:21:05.138Z',
        'name: does the app support Copilot sessions?',
      ].join('\n')
    );

    const m = readWorkspaceManifest(dir);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('879c0438-dace-429f-b4db-450aae9bde54');
    expect(m!.cwd).toBe('/Users/x/repo');
    expect(m!.repository).toBe('codemie-ai/codemie-code');
    expect(m!.branch).toBe('fix/analytics');
    expect(m!.createdAt).toBe(Date.parse('2026-06-16T06:21:01.974Z'));
    expect(m!.updatedAt).toBe(Date.parse('2026-06-16T06:21:05.138Z'));
    expect(m!.name).toBe('does the app support Copilot sessions?');
  });

  it('tolerates an older manifest missing host_type and name', () => {
    const dir = join(root, 'legacy');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'workspace.yaml'),
      ['id: legacy', 'cwd: /repo', 'created_at: 2026-01-29T10:59:02.482Z'].join('\n')
    );

    const m = readWorkspaceManifest(dir);
    expect(m!.id).toBe('legacy');
    expect(m!.repository).toBeUndefined();
    expect(m!.branch).toBeUndefined();
  });

  it('returns null on malformed YAML instead of throwing', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'workspace.yaml'), 'id: [unclosed\n  : :');
    expect(readWorkspaceManifest(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.workspace.test.ts`
Expected: FAIL — `Cannot find module '../copilot-cli.workspace.js'`

- [ ] **Step 3: Write the event types**

```ts
// src/agents/plugins/copilot-cli/copilot-cli-event-types.ts
/**
 * Shapes for GitHub Copilot CLI local session state.
 *
 * Two sources per session directory (~/.copilot/session-state/<uuid>/):
 *  - workspace.yaml — manifest, present in every session dir
 *  - events.jsonl   — transcript, present only from the schema-bearing CLI versions
 *
 * The events.jsonl schema is undocumented by GitHub. Every field is optional and
 * every consumer must degrade rather than throw.
 */

/** Parsed ~/.copilot/session-state/<uuid>/workspace.yaml. */
export interface CopilotWorkspaceManifest {
  id: string;
  cwd?: string;
  gitRoot?: string;
  repository?: string;
  hostType?: string;
  branch?: string;
  name?: string;
  createdAt?: number; // epoch ms
  updatedAt?: number; // epoch ms
}

/** Raw YAML key shape, before camelCase normalization. */
export interface RawWorkspaceYaml {
  id?: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  host_type?: string;
  branch?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
}

/** One line of events.jsonl. */
export interface CopilotEvent {
  type?: string;
  data?: unknown;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
}

/** Per-model usage buckets as Copilot writes them — OpenAI convention (see copilot-cli.usage.ts). */
export interface CopilotUsageBuckets {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** data of a `session.shutdown` event. */
export interface CopilotShutdownData {
  shutdownType?: string;
  totalPremiumRequests?: number;
  totalApiDurationMs?: number;
  codeChanges?: {
    linesAdded?: number;
    linesRemoved?: number;
    filesModified?: string[];
  };
  modelMetrics?: Record<string, {
    requests?: { count?: number; cost?: number };
    usage?: CopilotUsageBuckets;
  }>;
}

/** data of a `session.start` event. */
export interface CopilotSessionStartData {
  sessionId?: string;
  copilotVersion?: string;
  producer?: string;
  startTime?: string;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
    headCommit?: string;
    repository?: string;
    hostType?: string;
  };
}

/** data of an `assistant.message` event — the per-turn fallback token source. */
export interface CopilotAssistantMessageData {
  messageId?: string;
  model?: string;
  turnId?: string;
  outputTokens?: number;
  requestId?: string;
  toolRequests?: Array<{ toolCallId?: string; name?: string; arguments?: unknown }>;
}

/** data of a `tool.execution_complete` event. */
export interface CopilotToolCompleteData {
  toolCallId?: string;
  name?: string;
  status?: string;
  error?: unknown;
  arguments?: { path?: string };
}

/** data of a `skill.invoked` event. */
export interface CopilotSkillInvokedData {
  skill?: string;
  name?: string;
}
```

- [ ] **Step 4: Write the paths module**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.paths.ts
/**
 * Copilot CLI storage locations.
 *
 * Copilot honors COPILOT_HOME as an override of ~/.copilot. Discovery that ignores
 * it silently returns zero sessions for anyone who sets it.
 */

import { join } from 'path';
import { resolveHomeDir } from '../../../utils/paths.js';

/** ~/.copilot, or $COPILOT_HOME when set. */
export function getCopilotHome(): string {
  const override = process.env.COPILOT_HOME?.trim();
  if (override) {
    return override;
  }
  return join(resolveHomeDir(), '.copilot');
}

/** Directory holding one subdirectory per session. */
export function getCopilotSessionStateRoot(): string {
  return join(getCopilotHome(), 'session-state');
}
```

- [ ] **Step 5: Write the workspace manifest reader**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.workspace.ts
/**
 * Reads ~/.copilot/session-state/<uuid>/workspace.yaml.
 *
 * This is the discovery manifest: it carries session identity, project path, repo,
 * branch, and timestamps in ~350 bytes, so discovery never has to open a transcript
 * (observed transcripts reach 1.5 MB).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import type { CopilotWorkspaceManifest, RawWorkspaceYaml } from './copilot-cli-event-types.js';
import { logger } from '../../../utils/logger.js';

/** ISO-8601 string to epoch ms; undefined when absent or unparseable. */
function toEpochMs(iso?: string): number | undefined {
  if (!iso) {
    return undefined;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Parse one session directory's manifest. Returns null when the file is missing,
 * unreadable, malformed, or carries no session id — never throws.
 */
export function readWorkspaceManifest(sessionDir: string): CopilotWorkspaceManifest | null {
  let text: string;
  try {
    text = readFileSync(join(sessionDir, 'workspace.yaml'), 'utf-8');
  } catch {
    return null;
  }

  let raw: RawWorkspaceYaml;
  try {
    raw = (parseYaml(text) ?? {}) as RawWorkspaceYaml;
  } catch (e) {
    logger.debug(`[copilot-cli] malformed workspace.yaml in ${sessionDir}:`, e);
    return null;
  }

  if (!raw.id) {
    return null;
  }

  return {
    id: raw.id,
    cwd: raw.cwd,
    gitRoot: raw.git_root,
    repository: raw.repository,
    hostType: raw.host_type,
    branch: raw.branch,
    name: raw.name,
    createdAt: toEpochMs(raw.created_at),
    updatedAt: toEpochMs(raw.updated_at),
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.workspace.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 7: Commit**

```bash
git add src/agents/plugins/copilot-cli/
git commit -m "feat(analytics): add copilot-cli paths, event types, and workspace manifest reader"
```

---

## Task 2: Tolerant JSONL reader and session discovery

**Files:**
- Create: `src/agents/plugins/copilot-cli/copilot-cli.storage-utils.ts`
- Create: `src/agents/plugins/copilot-cli/copilot-cli.session.ts`
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.discovery.test.ts`

**Interfaces:**
- Consumes: `getCopilotSessionStateRoot()`, `readWorkspaceManifest()`, `CopilotEvent` (Task 1).
- Produces: `readCopilotEventsTolerant(filePath: string): CopilotEvent[]`, and `CopilotCliSessionAdapter` with `discoverSessions(options?): Promise<SessionDescriptor[]>`. `parseSessionFile` is stubbed here and completed in Task 3.

**Test-first: yes** — `discoverSessions` enumerates `session-state/*/`, skips directories with no `events.jsonl`, honors `maxAgeDays` and `limit`, and returns descriptors sorted newest-first with `filePath` pointing at `events.jsonl`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';

let home: string;
const DAY = 24 * 60 * 60 * 1000;

function makeSession(id: string, createdAt: number, withEvents = true): void {
  const dir = join(home, 'session-state', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'workspace.yaml'),
    [
      `id: ${id}`,
      'cwd: /repo/app',
      'git_root: /repo/app',
      'branch: main',
      `created_at: ${new Date(createdAt).toISOString()}`,
      `updated_at: ${new Date(createdAt + 1000).toISOString()}`,
    ].join('\n')
  );
  if (withEvents) {
    writeFileSync(join(dir, 'events.jsonl'), '{"type":"session.start","data":{}}\n');
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'copilot-home-'));
  process.env.COPILOT_HOME = home;
});

afterEach(() => {
  delete process.env.COPILOT_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('CopilotCliSessionAdapter.discoverSessions', () => {
  it('returns [] when session-state does not exist', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    expect(await a.discoverSessions()).toEqual([]);
  });

  it('discovers sessions and points filePath at events.jsonl', async () => {
    const now = Date.now();
    makeSession('aaa', now - DAY);
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const found = await a.discoverSessions();

    expect(found).toHaveLength(1);
    expect(found[0].sessionId).toBe('aaa');
    expect(found[0].filePath).toBe(join(home, 'session-state', 'aaa', 'events.jsonl'));
    expect(found[0].projectPath).toBe('/repo/app');
    expect(found[0].agentName).toBe('copilot-cli');
  });

  it('skips session dirs with no events.jsonl', async () => {
    const now = Date.now();
    makeSession('has-events', now - DAY, true);
    makeSession('no-events', now - DAY, false);
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const found = await a.discoverSessions();
    expect(found.map((d) => d.sessionId)).toEqual(['has-events']);
  });

  it('honors maxAgeDays', async () => {
    const now = Date.now();
    makeSession('recent', now - 2 * DAY);
    makeSession('ancient', now - 90 * DAY);
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const found = await a.discoverSessions({ maxAgeDays: 30 });
    expect(found.map((d) => d.sessionId)).toEqual(['recent']);
  });

  it('sorts newest-first and applies limit', async () => {
    const now = Date.now();
    makeSession('older', now - 5 * DAY);
    makeSession('newer', now - 1 * DAY);
    makeSession('middle', now - 3 * DAY);
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);

    expect((await a.discoverSessions()).map((d) => d.sessionId)).toEqual(['newer', 'middle', 'older']);
    expect((await a.discoverSessions({ limit: 2 })).map((d) => d.sessionId)).toEqual(['newer', 'middle']);
  });

  it('filters by cwd when supplied', async () => {
    const now = Date.now();
    makeSession('match', now - DAY);
    const other = join(home, 'session-state', 'other');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, 'workspace.yaml'),
      ['id: other', 'cwd: /somewhere/else', `created_at: ${new Date(now - DAY).toISOString()}`].join('\n')
    );
    writeFileSync(join(other, 'events.jsonl'), '{}\n');

    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const found = await a.discoverSessions({ cwd: '/repo/app' });
    expect(found.map((d) => d.sessionId)).toEqual(['match']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.discovery.test.ts`
Expected: FAIL — `Cannot find module '../copilot-cli.session.js'`

- [ ] **Step 3: Write the tolerant JSONL reader**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.storage-utils.ts
/**
 * Tolerant reader for Copilot's events.jsonl.
 *
 * A live session's final line may be truncated mid-write, and the schema is
 * undocumented. Unparseable lines are dropped, never thrown.
 */

import { readFileSync } from 'fs';
import type { CopilotEvent } from './copilot-cli-event-types.js';
import { logger } from '../../../utils/logger.js';

export function readCopilotEventsTolerant(filePath: string): CopilotEvent[] {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf-8');
  } catch (e) {
    logger.debug(`[copilot-cli] unreadable events.jsonl at ${filePath}:`, e);
    return [];
  }

  const events: CopilotEvent[] = [];
  let dropped = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as CopilotEvent);
    } catch {
      dropped++;
    }
  }
  if (dropped > 0) {
    logger.debug(`[copilot-cli] dropped ${dropped} unparseable line(s) in ${filePath}`);
  }
  return events;
}
```

- [ ] **Step 4: Write the session adapter with discovery**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.session.ts
/**
 * Copilot CLI Session Adapter.
 *
 * Sessions live at ~/.copilot/session-state/<uuid>/ (or $COPILOT_HOME/...).
 * Discovery reads only workspace.yaml — the transcript is opened during parse,
 * so a report run never pays to read transcripts it will filter out.
 */

import { readdirSync, existsSync } from 'fs';
import { join } from 'path';
import type {
  SessionAdapter,
  ParsedSession,
  AggregatedResult,
  SessionDiscoveryOptions,
  SessionDescriptor,
} from '../../core/session/BaseSessionAdapter.js';
import type { SessionProcessor, ProcessingContext } from '../../core/session/BaseProcessor.js';
import type { AgentMetadata } from '../../core/types.js';
import { getCopilotSessionStateRoot } from './copilot-cli.paths.js';
import { readWorkspaceManifest } from './copilot-cli.workspace.js';
import { logger } from '../../../utils/logger.js';

const DEFAULT_MAX_AGE_DAYS = 30;

/** Trailing-slash-insensitive project path comparison. */
function sameDir(a: string | undefined, b: string): boolean {
  if (!a) {
    return false;
  }
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

export class CopilotCliSessionAdapter implements SessionAdapter {
  readonly agentName = 'copilot-cli';
  private processors: SessionProcessor[] = [];

  constructor(private readonly metadata: AgentMetadata) {}

  registerProcessor(processor: SessionProcessor): void {
    this.processors.push(processor);
    this.processors.sort((a, b) => a.priority - b.priority);
    logger.debug(`[copilot-cli-adapter] Registered processor: ${processor.name} (priority: ${processor.priority})`);
  }

  /**
   * Enumerate session-state/<uuid>/ directories that have a transcript, newest first.
   * Sessions with no events.jsonl carry no usage or activity data and are skipped.
   */
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    const root = getCopilotSessionStateRoot();
    if (!existsSync(root)) {
      logger.debug(`[copilot-cli-discovery] no session-state directory at ${root}`);
      return [];
    }

    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (e) {
      logger.debug('[copilot-cli-discovery] failed to read session-state:', e);
      return [];
    }

    const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const results: SessionDescriptor[] = [];
    for (const name of dirs) {
      const dir = join(root, name);
      const eventsPath = join(dir, 'events.jsonl');
      if (!existsSync(eventsPath)) {
        continue; // pre-schema session — nothing to parse or price
      }

      const manifest = readWorkspaceManifest(dir);
      if (!manifest) {
        continue;
      }

      const createdAt = manifest.createdAt;
      if (createdAt === undefined) {
        if (!options?.includeTimestampless) {
          continue;
        }
      } else if (createdAt < cutoffMs) {
        continue;
      }

      const projectPath = manifest.cwd ?? manifest.gitRoot;
      if (options?.cwd && !sameDir(projectPath, options.cwd)) {
        continue;
      }

      results.push({
        sessionId: manifest.id,
        filePath: eventsPath,
        projectPath,
        createdAt: createdAt ?? 0,
        updatedAt: manifest.updatedAt,
        agentName: this.agentName,
      });
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (options?.limit && options.limit > 0) {
      logger.debug(`[copilot-cli-discovery] found ${results.length}, returning ${options.limit}`);
      return results.slice(0, options.limit);
    }
    logger.debug(`[copilot-cli-discovery] found ${results.length} session(s)`);
    return results;
  }

  // Completed in Task 3.
  async parseSessionFile(_filePath: string, sessionId: string): Promise<ParsedSession> {
    return { sessionId, agentName: this.metadata.displayName, metadata: {}, messages: [] };
  }

  // Completed in Task 6.
  async processSession(
    _filePath: string,
    _sessionId: string,
    _context: ProcessingContext
  ): Promise<AggregatedResult> {
    return { success: true, processors: {}, totalRecords: 0, failedProcessors: [] };
  }
}
```

- [ ] **Step 5: Write the minimal plugin so the test can import metadata**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.plugin.ts
/**
 * GitHub Copilot CLI — analytics-only agent plugin.
 *
 * CodeMie does NOT install, launch, configure, or proxy Copilot. This plugin exists
 * solely so AgentRegistry can hand the analytics pipeline a SessionAdapter
 * (native-loader.ts resolves adapters via AgentRegistry.getAgent(name).getSessionAdapter()).
 */

import type { AgentMetadata } from '../../core/types.js';
import { BaseAgentAdapter } from '../../core/BaseAgentAdapter.js';
import type { SessionAdapter } from '../../core/session/BaseSessionAdapter.js';
import { CopilotCliSessionAdapter } from './copilot-cli.session.js';

export const COPILOT_CLI_AGENT_NAME = 'copilot-cli';

export const CopilotCliPluginMetadata: AgentMetadata = {
  name: COPILOT_CLI_AGENT_NAME,
  displayName: 'GitHub Copilot CLI',
  description: 'GitHub Copilot CLI — analytics ingestion only (not managed by CodeMie)',
  npmPackage: '@github/copilot',
  cliCommand: 'copilot',
  dataPaths: {
    home: '.copilot',
  },
  analyticsOnly: true,
};

export class CopilotCliPlugin extends BaseAgentAdapter {
  readonly metadata = CopilotCliPluginMetadata;
  readonly name = COPILOT_CLI_AGENT_NAME;

  private sessionAdapter: SessionAdapter | null = null;

  getSessionAdapter(): SessionAdapter {
    if (!this.sessionAdapter) {
      this.sessionAdapter = new CopilotCliSessionAdapter(this.metadata);
    }
    return this.sessionAdapter;
  }
}
```

Add `analyticsOnly?: boolean;` to `AgentMetadata` in `src/agents/core/types.ts` (near `dataPaths`), documented as: *"True for agents CodeMie only reads analytics for and never installs, launches, or manages. Exempts the agent from the native-session ownership gate — see native-loader.ts."*

> If `BaseAgentAdapter` requires additional members that have no meaningful analytics-only implementation, implement the narrowest satisfying stub and add a one-line comment saying why. Do **not** add install/launch behavior.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.discovery.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add src/agents/plugins/copilot-cli/ src/agents/core/types.ts
git commit -m "feat(analytics): add copilot-cli session discovery and analytics-only plugin"
```

---

## Task 3: Token extraction — tier 1 (shutdown), tier 2 (per-turn), tier 3 (none)

**Files:**
- Create: `src/agents/plugins/copilot-cli/copilot-cli.usage.ts`
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.usage.test.ts`

**Interfaces:**
- Consumes: `CopilotEvent`, `CopilotShutdownData`, `CopilotAssistantMessageData`, `CopilotUsageBuckets` (Task 1).
- Produces:
  ```ts
  interface CopilotUsageMessage {
    model: string;
    usage: CopilotUsageBuckets; // RAW Copilot buckets — decomposition happens in Task 4
    requests?: number;
    partial?: boolean;          // true when reconstructed from per-turn events
  }
  interface CopilotUsageExtract {
    messages: CopilotUsageMessage[];
    premiumRequests?: number;
    partial: boolean;
    unavailableReason?: string;
  }
  export function extractCopilotUsage(events: CopilotEvent[]): CopilotUsageExtract;
  ```

This function emits **raw** Copilot buckets deliberately. The repo's other readers (`readClaude`, `readGemini`) consume raw agent fields and do their own math, and keeping the decomposition in exactly one place — Task 4's `readCopilotCli` — is what makes it a single, testable seam.

**Test-first: yes** — tier 1 returns per-model raw buckets and `premiumRequests` from `session.shutdown`; tier 2 reconstructs per-model output tokens and request counts from `assistant.message` when shutdown is absent and marks `partial: true`; tier 3 returns empty with a reason.

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.usage.test.ts
import { describe, it, expect } from 'vitest';
import { extractCopilotUsage } from '../copilot-cli.usage.js';
import type { CopilotEvent } from '../copilot-cli-event-types.js';

// Real numbers measured from ~/.copilot session 2bcffe67 (CLI 1.0.48), a mixed-model session.
const shutdownEvent: CopilotEvent = {
  type: 'session.shutdown',
  data: {
    shutdownType: 'routine',
    totalPremiumRequests: 3,
    modelMetrics: {
      'gpt-5.2': {
        requests: { count: 374, cost: 3 },
        usage: { inputTokens: 14076695, outputTokens: 173180, cacheReadTokens: 13694976, cacheWriteTokens: 0, reasoningTokens: 90359 },
      },
      'claude-sonnet-4.5': {
        requests: { count: 60, cost: 0 },
        usage: { inputTokens: 1654378, outputTokens: 27215, cacheReadTokens: 1504366, cacheWriteTokens: 125660, reasoningTokens: 0 },
      },
    },
  },
};

function turn(model: string, outputTokens: number): CopilotEvent {
  return { type: 'assistant.message', data: { model, outputTokens } };
}

describe('extractCopilotUsage — tier 1 (session.shutdown)', () => {
  it('returns raw per-model buckets and premium requests', () => {
    const r = extractCopilotUsage([{ type: 'session.start', data: {} }, shutdownEvent]);

    expect(r.partial).toBe(false);
    expect(r.premiumRequests).toBe(3);
    expect(r.messages).toHaveLength(2);

    const gpt = r.messages.find((m) => m.model === 'gpt-5.2')!;
    expect(gpt.usage.inputTokens).toBe(14076695);
    expect(gpt.usage.cacheReadTokens).toBe(13694976);
    expect(gpt.requests).toBe(374);

    const claude = r.messages.find((m) => m.model === 'claude-sonnet-4.5')!;
    expect(claude.usage.cacheWriteTokens).toBe(125660);
    expect(claude.requests).toBe(60);
  });

  it('treats requests.cost 0 as real data, not missing', () => {
    const r = extractCopilotUsage([shutdownEvent]);
    expect(r.premiumRequests).toBe(3);
    expect(r.unavailableReason).toBeUndefined();
  });
});

describe('extractCopilotUsage — tier 2 (per-turn fallback)', () => {
  it('reconstructs per-model output tokens and marks the result partial', () => {
    const r = extractCopilotUsage([
      { type: 'session.start', data: {} },
      turn('gpt-5.2', 100),
      turn('gpt-5.2', 250),
      turn('claude-sonnet-4.5', 40),
    ]);

    expect(r.partial).toBe(true);
    const gpt = r.messages.find((m) => m.model === 'gpt-5.2')!;
    expect(gpt.usage.outputTokens).toBe(350);
    expect(gpt.requests).toBe(2);
    expect(gpt.usage.inputTokens ?? 0).toBe(0); // unrecoverable per-turn
    expect(gpt.partial).toBe(true);

    const claude = r.messages.find((m) => m.model === 'claude-sonnet-4.5')!;
    expect(claude.usage.outputTokens).toBe(40);
  });

  it('prefers shutdown over per-turn when both are present', () => {
    const r = extractCopilotUsage([turn('gpt-5.2', 999), shutdownEvent]);
    expect(r.partial).toBe(false);
    expect(r.messages.find((m) => m.model === 'gpt-5.2')!.usage.outputTokens).toBe(173180);
  });

  it('uses the last shutdown when a session records more than one', () => {
    const second: CopilotEvent = {
      type: 'session.shutdown',
      data: {
        totalPremiumRequests: 5,
        modelMetrics: { 'gpt-5.2': { requests: { count: 2 }, usage: { inputTokens: 10, outputTokens: 2 } } },
      },
    };
    const r = extractCopilotUsage([shutdownEvent, second]);
    expect(r.premiumRequests).toBe(5);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].usage.inputTokens).toBe(10);
  });
});

describe('extractCopilotUsage — tier 3 (no usage data)', () => {
  it('returns empty with a reason when no usage events exist', () => {
    const r = extractCopilotUsage([{ type: 'session.start', data: {} }, { type: 'user.message', data: {} }]);
    expect(r.messages).toEqual([]);
    expect(r.unavailableReason).toBeTruthy();
  });

  it('ignores assistant.message events that carry no outputTokens', () => {
    const r = extractCopilotUsage([{ type: 'assistant.message', data: { model: 'gpt-5.2' } }]);
    expect(r.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.usage.test.ts`
Expected: FAIL — `Cannot find module '../copilot-cli.usage.js'`

- [ ] **Step 3: Write the extractor**

```ts
// src/agents/plugins/copilot-cli/copilot-cli.usage.ts
/**
 * Token extraction from a Copilot CLI transcript, in three tiers.
 *
 *  Tier 1 — `session.shutdown`.`modelMetrics`: the authoritative per-model rollup.
 *  Tier 2 — per-turn `assistant.message`: recovers output tokens and request counts
 *           exactly (verified against tier 1 on real sessions), but NO input or cache
 *           tokens exist per turn. Marked `partial` because input outweighs output ~100:1.
 *  Tier 3 — neither: no usage data; the session is listed unpriced with a reason.
 *
 * Buckets are emitted RAW (Copilot's OpenAI-convention field names). The conversion into
 * the repo's TokenUsage happens in exactly one place — readCopilotCli in usage-readers.ts.
 */

import type {
  CopilotEvent,
  CopilotShutdownData,
  CopilotAssistantMessageData,
  CopilotUsageBuckets,
} from './copilot-cli-event-types.js';

export interface CopilotUsageMessage {
  model: string;
  usage: CopilotUsageBuckets;
  requests?: number;
  partial?: boolean;
}

export interface CopilotUsageExtract {
  messages: CopilotUsageMessage[];
  premiumRequests?: number;
  partial: boolean;
  unavailableReason?: string;
}

const NO_USAGE_REASON =
  'No usage data in transcript — Copilot CLI recorded no token telemetry for this session';

/** Last shutdown wins: a resumed session can record more than one. */
function lastShutdown(events: CopilotEvent[]): CopilotShutdownData | null {
  let found: CopilotShutdownData | null = null;
  for (const e of events) {
    if (e.type === 'session.shutdown' && e.data) {
      found = e.data as CopilotShutdownData;
    }
  }
  return found;
}

function fromShutdown(data: CopilotShutdownData): CopilotUsageMessage[] {
  const out: CopilotUsageMessage[] = [];
  for (const [model, entry] of Object.entries(data.modelMetrics ?? {})) {
    if (!entry?.usage) {
      continue;
    }
    out.push({ model, usage: entry.usage, requests: entry.requests?.count });
  }
  return out;
}

function fromPerTurn(events: CopilotEvent[]): CopilotUsageMessage[] {
  const byModel = new Map<string, { output: number; requests: number }>();
  for (const e of events) {
    if (e.type !== 'assistant.message' || !e.data) {
      continue;
    }
    const d = e.data as CopilotAssistantMessageData;
    if (!d.model || typeof d.outputTokens !== 'number') {
      continue;
    }
    const acc = byModel.get(d.model) ?? { output: 0, requests: 0 };
    acc.output += d.outputTokens;
    acc.requests += 1;
    byModel.set(d.model, acc);
  }

  return [...byModel.entries()].map(([model, acc]) => ({
    model,
    usage: { outputTokens: acc.output },
    requests: acc.requests,
    partial: true,
  }));
}

export function extractCopilotUsage(events: CopilotEvent[]): CopilotUsageExtract {
  const shutdown = lastShutdown(events);
  if (shutdown) {
    const messages = fromShutdown(shutdown);
    if (messages.length > 0) {
      return { messages, premiumRequests: shutdown.totalPremiumRequests, partial: false };
    }
  }

  const perTurn = fromPerTurn(events);
  if (perTurn.length > 0) {
    return {
      messages: perTurn,
      premiumRequests: shutdown?.totalPremiumRequests,
      partial: true,
    };
  }

  return { messages: [], partial: false, unavailableReason: NO_USAGE_REASON };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.usage.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/copilot-cli/
git commit -m "feat(analytics): extract copilot-cli token usage with per-turn fallback"
```

---

## Task 4: ⚠️ The cache-inclusive decomposition — `readCopilotCli`

> **Highest-risk task in this plan.** Copilot reports `inputTokens` **inclusive** of `cacheReadTokens` (OpenAI convention, applied even to Claude models). `cost-calculator.ts:51` bills `usage.input` at full rate **and** `usage.cacheRead` separately — the Anthropic convention. Passing Copilot's raw `inputTokens` straight through over-counts the input component **~36×** on a real measured session. This task exists on its own so that arithmetic has its own test.

**Files:**
- Modify: `src/cli/commands/analytics/cost/usage-readers.ts`
- Test: `src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts` (extend)

**Interfaces:**
- Consumes: `CopilotUsageMessage` shape from Task 3 (as `parsed.messages` entries).
- Produces: `readCopilotCli(parsed: ParsedSession): UsageMap` (module-private; exercised through `readUsageByModel` in Task 5).

**Test-first: yes** — with the measured session numbers, `readCopilotCli` must yield `input` 381 719 (not 14 076 695) for `gpt-5.2`, and for `claude-sonnet-4.5` must split fresh input into `cacheCreation` 125 660 + `input` 24 352.

- [ ] **Step 1: Write the failing test (append to the existing describe blocks)**

```ts
// src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts  (append)

// Measured from a real ~/.copilot session (CLI 1.0.48). The adapter emits Copilot's RAW
// buckets; the reader must convert OpenAI-convention (input INCLUDES cache read) into the
// repo's Anthropic-convention TokenUsage (input EXCLUDES cache read).
const copilotParsed = {
  sessionId: 's-copilot',
  agentName: 'GitHub Copilot CLI',
  metadata: {},
  messages: [
    {
      model: 'gpt-5.2',
      requests: 374,
      usage: {
        inputTokens: 14076695,
        outputTokens: 173180,
        cacheReadTokens: 13694976,
        cacheWriteTokens: 0,
        reasoningTokens: 90359,
      },
    },
    {
      model: 'claude-sonnet-4.5',
      requests: 60,
      usage: {
        inputTokens: 1654378,
        outputTokens: 27215,
        cacheReadTokens: 1504366,
        cacheWriteTokens: 125660,
        reasoningTokens: 0,
      },
    },
  ],
} as never;

describe('readUsageByModel — copilot-cli cache decomposition', () => {
  it('subtracts cache reads from inputTokens instead of double-billing them', () => {
    const m = readUsageByModel('copilot-cli', copilotParsed);
    const u = m.get('gpt-5.2')!;

    // 14,076,695 − 13,694,976 = 381,719. The raw value would over-bill ~36x.
    expect(u.input).toBe(381719);
    expect(u.cacheRead).toBe(13694976);
    expect(u.output).toBe(173180);
    expect(u.cacheCreation).toBe(0);
  });

  it('splits fresh input into cache-write and plain input for Anthropic models', () => {
    const m = readUsageByModel('copilot-cli', copilotParsed);
    const u = m.get('claude-sonnet-4.5')!;

    // fresh = 1,654,378 − 1,504,366 = 150,012; of which 125,660 were cache writes.
    expect(u.cacheCreation).toBe(125660);
    expect(u.input).toBe(24352);
    expect(u.cacheRead).toBe(1504366);
    expect(u.cacheCreation1h).toBe(0); // Copilot exposes no TTL split
  });

  it('never bills reasoning tokens separately (they are inside outputTokens)', () => {
    const m = readUsageByModel('copilot-cli', copilotParsed);
    expect(m.get('gpt-5.2')!.output).toBe(173180); // not 173180 + 90359
  });

  it('clamps to zero rather than going negative on inconsistent buckets', () => {
    const weird = {
      sessionId: 's-weird',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ model: 'gpt-5.2', usage: { inputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 900 } }],
    } as never;
    const u = readUsageByModel('copilot-cli', weird).get('gpt-5.2')!;
    expect(u.input).toBe(0);
    expect(u.input).not.toBeLessThan(0);
  });

  it('handles the output-only partial shape from the per-turn fallback', () => {
    const partial = {
      sessionId: 's-partial',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ model: 'gpt-5.2', requests: 3, partial: true, usage: { outputTokens: 350 } }],
    } as never;
    const u = readUsageByModel('copilot-cli', partial).get('gpt-5.2')!;
    expect(u.output).toBe(350);
    expect(u.input).toBe(0);
    expect(u.total).toBe(350);
  });

  it('sums repeated entries for the same model', () => {
    const dup = {
      sessionId: 's-dup',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [
        { model: 'gpt-5.2', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 40 } },
        { model: 'gpt-5.2', usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 50 } },
      ],
    } as never;
    const u = readUsageByModel('copilot-cli', dup).get('gpt-5.2')!;
    expect(u.input).toBe(60 + 150);
    expect(u.output).toBe(30);
    expect(u.cacheRead).toBe(90);
  });

  it('skips entries with no model or no usage', () => {
    const junk = {
      sessionId: 's-junk',
      agentName: 'GitHub Copilot CLI',
      metadata: {},
      messages: [{ usage: { inputTokens: 5 } }, { model: 'gpt-5.2' }, 'not-an-object'],
    } as never;
    expect(readUsageByModel('copilot-cli', junk).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts -t "copilot-cli cache decomposition"`
Expected: FAIL — `readUsageByModel('copilot-cli', ...)` returns an empty Map, so `m.get('gpt-5.2')` is `undefined`

- [ ] **Step 3: Add the reader to `usage-readers.ts`**

Insert after `readGemini` (around line 254):

```ts
/**
 * Raw per-model buckets as the Copilot adapter emits them (Copilot's own field names).
 * Copilot normalizes every provider to the OpenAI convention.
 */
interface CopilotCliRawMessage {
  model?: string;
  requests?: number;
  partial?: boolean;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
  };
}

/**
 * GitHub Copilot CLI.
 *
 * CONVENTION MISMATCH — the reason this reader is not a pass-through:
 *   Copilot: `inputTokens` INCLUDES `cacheReadTokens` (OpenAI convention), and applies
 *            that convention to Anthropic models too.
 *   This repo: `costBreakdown` bills `input` at full rate AND `cacheRead` separately,
 *            i.e. `TokenUsage.input` must EXCLUDE cache reads (Anthropic convention).
 * Passing `inputTokens` through unchanged over-counts input ~36x on a real session.
 *
 * `reasoningTokens` is a SUBSET of `outputTokens` (OpenAI convention, corroborated by
 * per-turn output sums matching the shutdown rollup exactly) — never billed separately.
 * `cacheWriteTokens` is treated as a subset of fresh input: observed data has
 * cacheWrite (125,660) < fresh input (150,012), and subtracting can never over-bill.
 * Copilot exposes no cache TTL split, so all writes land in the 5m bucket.
 */
function readCopilotCli(parsed: ParsedSession): UsageMap {
  const out: UsageMap = new Map();
  for (const arr of allMessageArrays(parsed)) {
    for (const raw of arr as CopilotCliRawMessage[]) {
      if (!raw || typeof raw !== 'object' || !raw.model || !raw.usage) {
        continue;
      }
      const u = raw.usage;
      const cacheRead = u.cacheReadTokens ?? 0;
      const cacheCreation = u.cacheWriteTokens ?? 0;
      const output = u.outputTokens ?? 0;

      // inputTokens is the TOTAL prompt; peel off the cached and cache-written parts.
      const freshInput = Math.max(0, (u.inputTokens ?? 0) - cacheRead);
      const input = Math.max(0, freshInput - cacheCreation);

      accumulate(out, raw.model, {
        input,
        output,
        cacheRead,
        cacheCreation,
        cacheCreation1h: 0,
        total: input + output + cacheRead + cacheCreation,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Wire it into `readUsageByModel` only (dedup path is Task 5)**

In `readUsageByModel` (~line 460), add before `default`:

```ts
    case 'copilot-cli':
      return readCopilotCli(parsed);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts -t "copilot-cli cache decomposition"`
Expected: PASS — 7 tests

- [ ] **Step 6: Run the whole cost suite for regressions**

Run: `npx vitest run src/cli/commands/analytics/cost/`
Expected: PASS — no existing test changes behavior

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/cost/
git commit -m "feat(analytics): price copilot-cli usage with cache-inclusive token decomposition"
```

---

## Task 5: The `gatherUsageDeduped` branch — the $0-totals trap

> The cost enricher does **not** call `readUsageByModel` for run-level totals; it calls `gatherUsageDeduped`. An agent branched into one but not the other produces correct per-session numbers and **$0 report totals** — a silent, plausible-looking failure. This is its own task so it gets its own regression guard.

**Files:**
- Modify: `src/cli/commands/analytics/cost/usage-readers.ts:478`
- Test: `src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts` (extend)

**Interfaces:**
- Consumes: `readCopilotCli` (Task 4).
- Produces: run-level totals for `copilot-cli` via `gatherUsageDeduped`.

**Test-first: yes** — `gatherUsageDeduped('copilot-cli', parsed, new Set())` returns a populated map with the same decomposed values as `readUsageByModel`, and a second call with a shared `seen` set is not suppressed (Copilot is session-local, so there is nothing to dedup across sessions).

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts  (append)
import { gatherUsageDeduped } from '../usage-readers.js'; // add to the existing import if absent

describe('gatherUsageDeduped — copilot-cli', () => {
  it('returns populated run-level totals (guards the $0-totals trap)', () => {
    const m = gatherUsageDeduped('copilot-cli', copilotParsed, new Set());
    expect(m.size).toBe(2);
    expect(m.get('gpt-5.2')!.input).toBe(381719);
    expect(m.get('claude-sonnet-4.5')!.cacheCreation).toBe(125660);
  });

  it('agrees with readUsageByModel', () => {
    const a = readUsageByModel('copilot-cli', copilotParsed);
    const b = gatherUsageDeduped('copilot-cli', copilotParsed, new Set());
    expect([...b.entries()]).toEqual([...a.entries()]);
  });

  it('is session-local — a shared seen set does not suppress a second session', () => {
    const seen = new Set<string>();
    const first = gatherUsageDeduped('copilot-cli', copilotParsed, seen);
    const second = gatherUsageDeduped('copilot-cli', copilotParsed, seen);
    expect(second.get('gpt-5.2')!.input).toBe(first.get('gpt-5.2')!.input);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts -t "gatherUsageDeduped — copilot-cli"`
Expected: FAIL — `expected 0 to be 2` (`gatherUsageDeduped` falls through to `new Map()`)

- [ ] **Step 3: Add the branch**

In `gatherUsageDeduped` (~line 480), alongside the `gemini` / `kimi` branches:

```ts
  if (a === 'copilot-cli') {
    // Session-local, like gemini/kimi: Copilot never replays one API response into
    // another session file, so there is no cross-session key to dedup on.
    return readCopilotCli(parsed);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts -t "gatherUsageDeduped — copilot-cli"`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/cost/usage-readers.ts src/cli/commands/analytics/cost/__tests__/
git commit -m "feat(analytics): branch gatherUsageDeduped for copilot-cli run-level totals"
```

---

## Task 6: `parseSessionFile` — metrics, metadata, and skill invocations

**Files:**
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.session.ts`
- Create: `src/agents/plugins/copilot-cli/session/processors/copilot-cli.metrics-processor.ts`
- Create: `src/agents/plugins/copilot-cli/session/processors/copilot-cli.conversations-processor.ts`
- Create: `src/agents/plugins/copilot-cli/index.ts`
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.parse.test.ts`

**Interfaces:**
- Consumes: `readCopilotEventsTolerant` (Task 2), `extractCopilotUsage` (Task 3).
- Produces: a `ParsedSession` whose `messages` are `CopilotUsageMessage[]` (what Task 4's reader consumes) and whose `metrics` populate the report's activity views. Also `parsed.premiumRequests`-equivalent data surfaced via `metadata`.

**Test-first: yes** — `parseSessionFile` on a fixture transcript yields `messages` with per-model raw buckets, `metadata` from `session.start`, `metrics.tools` / `toolStatus` / `fileOperations` from tool events, and `metrics.skillInvocations` from `skill.invoked`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.parse.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliSessionAdapter } from '../copilot-cli.session.js';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';

let dir: string;
let file: string;

const LINES = [
  { type: 'session.start', timestamp: '2026-06-16T06:21:01.983Z', data: {
      sessionId: 'sess-1', copilotVersion: '1.0.48',
      context: { cwd: '/repo/app', gitRoot: '/repo/app', branch: 'main', repository: 'org/app' } } },
  { type: 'user.message', timestamp: '2026-06-16T06:21:02Z', data: { text: 'hello' } },
  { type: 'skill.invoked', timestamp: '2026-06-16T06:21:03Z', data: { skill: 'superpowers:brainstorming' } },
  { type: 'assistant.message', timestamp: '2026-06-16T06:21:04Z', data: { model: 'gpt-5.4', outputTokens: 296 } },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:05Z', data: { name: 'view', status: 'success', arguments: { path: '/repo/app/a.ts' } } },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:06Z', data: { name: 'view', status: 'success', arguments: { path: '/repo/app/b.ts' } } },
  { type: 'tool.execution_complete', timestamp: '2026-06-16T06:21:07Z', data: { name: 'bash', status: 'error' } },
  { type: 'session.shutdown', timestamp: '2026-06-16T06:21:08Z', data: {
      shutdownType: 'routine', totalPremiumRequests: 3,
      codeChanges: { linesAdded: 12, linesRemoved: 4, filesModified: ['/repo/app/a.ts'] },
      modelMetrics: { 'gpt-5.4': { requests: { count: 22 },
        usage: { inputTokens: 1431122, outputTokens: 10684, cacheReadTokens: 1235968, cacheWriteTokens: 0, reasoningTokens: 4422 } } } } },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-parse-'));
  file = join(dir, 'events.jsonl');
  writeFileSync(file, LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CopilotCliSessionAdapter.parseSessionFile', () => {
  it('maps session.start into metadata', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(file, 'sess-1');
    expect(p.sessionId).toBe('sess-1');
    expect(p.metadata.projectPath).toBe('/repo/app');
    expect(p.metadata.branch).toBe('main');
    expect(p.metadata.repository).toBe('org/app');
    expect(p.agentVersion).toBe('1.0.48');
  });

  it('emits raw per-model usage buckets as messages', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(file, 'sess-1');
    const m = (p.messages as Array<{ model: string; usage: { inputTokens?: number } }>)[0];
    expect(m.model).toBe('gpt-5.4');
    expect(m.usage.inputTokens).toBe(1431122); // RAW — the reader decomposes
  });

  it('extracts tool counts and success/failure status', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(file, 'sess-1');
    expect(p.metrics!.tools).toEqual({ view: 2, bash: 1 });
    expect(p.metrics!.toolStatus!.view).toEqual({ success: 2, failure: 0 });
    expect(p.metrics!.toolStatus!.bash).toEqual({ success: 0, failure: 1 });
  });

  it('extracts skill invocations so the Source column can classify the session', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(file, 'sess-1');
    expect(p.metrics!.skillInvocations).toEqual({ 'superpowers:brainstorming': 1 });
  });

  it('records code changes from session.shutdown', async () => {
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(file, 'sess-1');
    const ops = p.metrics!.fileOperations!;
    expect(ops.some((o) => o.path === '/repo/app/a.ts' && o.linesAdded === 12 && o.linesRemoved === 4)).toBe(true);
  });

  it('degrades gracefully on an empty or malformed transcript', async () => {
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, 'not json\n{"type":"session.start"\n');
    const a = new CopilotCliSessionAdapter(CopilotCliPluginMetadata);
    const p = await a.parseSessionFile(bad, 'sess-bad');
    expect(p.sessionId).toBe('sess-bad');
    expect(p.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.parse.test.ts`
Expected: FAIL — `parseSessionFile` returns the Task-2 stub, so `metadata.projectPath` is `undefined`

- [ ] **Step 3: Implement `parseSessionFile`**

Replace the Task-2 stub in `copilot-cli.session.ts`, and add these imports at the top:

```ts
import { readCopilotEventsTolerant } from './copilot-cli.storage-utils.js';
import { extractCopilotUsage } from './copilot-cli.usage.js';
import type {
  CopilotEvent,
  CopilotSessionStartData,
  CopilotShutdownData,
  CopilotToolCompleteData,
  CopilotSkillInvokedData,
} from './copilot-cli-event-types.js';
```

```ts
  /**
   * Read events.jsonl into the unified ParsedSession.
   *
   * `messages` carries the RAW per-model Copilot buckets — readCopilotCli in
   * usage-readers.ts owns the conversion into TokenUsage, so the convention
   * mismatch lives in exactly one place.
   */
  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    const events = readCopilotEventsTolerant(filePath);

    const start = events.find((e) => e.type === 'session.start')?.data as CopilotSessionStartData | undefined;
    const shutdown = [...events].reverse().find((e) => e.type === 'session.shutdown')?.data as
      | CopilotShutdownData
      | undefined;

    const usage = extractCopilotUsage(events);

    const tools: Record<string, number> = {};
    const toolStatus: Record<string, { success: number; failure: number }> = {};
    const skillInvocations: Record<string, number> = {};
    const userPrompts: Array<{ count: number; text: string }> = [];
    const fileOperations: NonNullable<ParsedSession['metrics']>['fileOperations'] = [];

    for (const e of events) {
      switch (e.type) {
        case 'tool.execution_complete': {
          const d = (e.data ?? {}) as CopilotToolCompleteData;
          const name = d.name;
          if (!name) {
            break;
          }
          tools[name] = (tools[name] ?? 0) + 1;
          const bucket = toolStatus[name] ?? { success: 0, failure: 0 };
          const failed = d.status === 'error' || d.error !== undefined;
          bucket[failed ? 'failure' : 'success'] += 1;
          toolStatus[name] = bucket;
          break;
        }
        case 'skill.invoked': {
          const d = (e.data ?? {}) as CopilotSkillInvokedData;
          const name = d.skill ?? d.name;
          if (name) {
            skillInvocations[name] = (skillInvocations[name] ?? 0) + 1;
          }
          break;
        }
        case 'user.message': {
          const text = (e.data as { text?: string } | undefined)?.text;
          if (typeof text === 'string' && text.trim()) {
            userPrompts.push({ count: 1, text });
          }
          break;
        }
        default:
          break;
      }
    }

    // session.shutdown.codeChanges is the authoritative churn figure; Copilot does not
    // report per-file line deltas, so attribute the totals to the first modified file
    // and list the rest as touched.
    const changes = shutdown?.codeChanges;
    const modified = changes?.filesModified ?? [];
    modified.forEach((path, i) => {
      fileOperations.push({
        type: 'edit',
        path,
        linesAdded: i === 0 ? changes?.linesAdded ?? 0 : 0,
        linesRemoved: i === 0 ? changes?.linesRemoved ?? 0 : 0,
      });
    });

    const ctx = start?.context;
    return {
      sessionId,
      agentName: this.metadata.displayName,
      agentVersion: start?.copilotVersion,
      metadata: {
        projectPath: ctx?.cwd ?? ctx?.gitRoot,
        createdAt: start?.startTime,
        repository: ctx?.repository,
        branch: ctx?.branch,
        gitBranch: ctx?.branch,
      },
      messages: usage.messages,
      metrics: {
        tools,
        toolStatus,
        fileOperations,
        skillInvocations,
        userPrompts,
      },
    };
  }
```

- [ ] **Step 4: Add the processors and barrel export**

```ts
// src/agents/plugins/copilot-cli/session/processors/copilot-cli.metrics-processor.ts
/**
 * Metrics processor for Copilot CLI sessions. Extraction happens in
 * parseSessionFile; this processor exists so the adapter matches the
 * SessionProcessor orchestration every other agent uses.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';

export class CopilotCliMetricsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-metrics';
  readonly priority = 10;

  async process(parsed: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    const toolCalls = Object.values(parsed.metrics?.tools ?? {}).reduce((a, b) => a + b, 0);
    return { success: true, recordsProcessed: toolCalls };
  }
}
```

```ts
// src/agents/plugins/copilot-cli/session/processors/copilot-cli.conversations-processor.ts
/**
 * Conversations processor for Copilot CLI sessions. Copilot persists prompt text
 * in events.jsonl; parseSessionFile captures it into metrics.userPrompts.
 */

import type { SessionProcessor, ProcessingContext, ProcessingResult } from '../../../../core/session/BaseProcessor.js';
import type { ParsedSession } from '../../../../core/session/BaseSessionAdapter.js';

export class CopilotCliConversationsProcessor implements SessionProcessor {
  readonly name = 'copilot-cli-conversations';
  readonly priority = 20;

  async process(parsed: ParsedSession, _context: ProcessingContext): Promise<ProcessingResult> {
    return { success: true, recordsProcessed: parsed.metrics?.userPrompts?.length ?? 0 };
  }
}
```

```ts
// src/agents/plugins/copilot-cli/index.ts
export { CopilotCliPlugin, CopilotCliPluginMetadata, COPILOT_CLI_AGENT_NAME } from './copilot-cli.plugin.js';
```

Register the processors in the adapter constructor and implement `processSession` following `CodexSessionAdapter` (`src/agents/plugins/codex/codex.session.ts:64-101`) — read the file once, pass the `ParsedSession` to each processor in priority order, aggregate into `AggregatedResult`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.parse.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 6: Commit**

```bash
git add src/agents/plugins/copilot-cli/
git commit -m "feat(analytics): parse copilot-cli transcripts into ParsedSession with metrics"
```

---

## Task 7: Register the plugin

**Files:**
- Modify: `src/agents/registry.ts:1-40`
- Test: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts`

**Interfaces:**
- Consumes: `CopilotCliPlugin` (Tasks 2 & 6).
- Produces: `AgentRegistry.getAgent('copilot-cli')?.getSessionAdapter?.()` resolving to a `CopilotCliSessionAdapter` — the exact call `native-loader.ts:139` makes.

**Test-first: yes** — `AgentRegistry.getAgent('copilot-cli')` returns a plugin whose `getSessionAdapter()` exposes `discoverSessions`, and registering it leaves the other 8 plugins resolvable.

- [ ] **Step 1: Write the failing test**

```ts
// src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts
import { describe, it, expect } from 'vitest';
import { AgentRegistry } from '../../../registry.js';

describe('copilot-cli registration', () => {
  it('resolves through the exact call native-loader makes', () => {
    const adapter = AgentRegistry.getAgent('copilot-cli')?.getSessionAdapter?.();
    expect(adapter).toBeDefined();
    expect(typeof adapter!.discoverSessions).toBe('function');
    expect(adapter!.agentName).toBe('copilot-cli');
  });

  it('advertises the user-facing display label', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.displayName).toBe('GitHub Copilot CLI');
  });

  it('is marked analytics-only', () => {
    expect(AgentRegistry.getAgent('copilot-cli')!.metadata.analyticsOnly).toBe(true);
  });

  it('does not disturb existing agents', () => {
    for (const name of ['claude', 'codex', 'gemini', 'kimi', 'opencode']) {
      expect(AgentRegistry.getAgent(name), `${name} should still resolve`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts`
Expected: FAIL — `expected undefined to be defined`

- [ ] **Step 3: Register the plugin**

In `src/agents/registry.ts`, add the import next to the others:

```ts
import { CopilotCliPlugin } from './plugins/copilot-cli/index.js';
```

and register it inside `initialize()` after `KimiAcpPlugin`:

```ts
    AgentRegistry.registerPlugin(new CopilotCliPlugin());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Verify no command that iterates all plugins regressed**

Run: `npx vitest run src/agents/`
Expected: PASS. If a test fails because it asserts an exact plugin count or iterates all plugins expecting install/launch capability, fix it by teaching that code to skip `metadata.analyticsOnly` agents — **not** by adding install behavior to this plugin.

- [ ] **Step 6: Commit**

```bash
git add src/agents/registry.ts src/agents/plugins/copilot-cli/
git commit -m "feat(analytics): register copilot-cli plugin in the agent registry"
```

---

## Task 8: ⚠️ Native discovery + the ownership-gate exemption

> **Second highest-risk task.** `native-loader.ts:518` tags natively-discovered sessions with no CodeMie ownership marker as `provider: 'native-external'`, and `sources/sessions-source.ts:22` filters those out unless `--include-external`. A Copilot session can never carry an ownership marker, so **without this exemption 100% of Copilot sessions are silently dropped** and the entire feature ships displaying nothing.

**Files:**
- Modify: `src/cli/commands/analytics/native-loader.ts:31` and `:518`
- Test: `src/cli/commands/analytics/__tests__/native-loader.test.ts` (extend)

**Interfaces:**
- Consumes: registered plugin (Task 7).
- Produces: `copilot-cli` in `NATIVE_AGENTS`; analytics-only sessions never tagged `native-external`.

**Test-first: yes** — a discovered `copilot-cli` session keeps `provider: 'native'` (survives the default, no-`--include-external` path) even with `hasOwnershipMarker` returning false, while a `claude` session with no marker is still tagged `native-external`.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/commands/analytics/__tests__/native-loader.test.ts  (append)

const copilotParsedSession = {
  sessionId: 'cp1',
  agentName: 'GitHub Copilot CLI',
  metadata: { projectPath: '/repo/app', branch: 'main' },
  messages: [{ model: 'gpt-5.4', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 400 } }],
  metrics: { tools: { view: 2 }, toolStatus: { view: { success: 2, failure: 0 } }, fileOperations: [] },
} as never;

function depsFor(agentName: string, parsed: unknown): NativeLoaderDeps {
  return {
    trackedLogPaths: () => new Set<string>(),
    async discover() {
      return [{
        agentName,
        descriptor: {
          sessionId: 'cp1',
          filePath: `/copilot/session-state/cp1/events.jsonl`,
          projectPath: '/repo/app',
          createdAt: 1000,
          updatedAt: 2000,
          agentName,
        },
      }];
    },
    async parse() {
      return parsed as never;
    },
    realPath: (p: string) => p,
    // No CodeMie ownership marker — the situation every Copilot session is in.
    hasOwnershipMarker: () => false,
  };
}

describe('ownership gate — analytics-only agents', () => {
  it('does NOT tag a copilot-cli session as native-external', async () => {
    const out = await loadNativeSessions({} as never, depsFor('copilot-cli', copilotParsedSession));
    expect(out).toHaveLength(1);
    // 'native-external' here would mean sessions-source.ts filters it out by default,
    // i.e. the feature would ship showing nothing.
    expect(out[0].startEvent!.data.provider).toBe('native');
  });

  it('still tags an unowned claude session as native-external', async () => {
    const out = await loadNativeSessions({} as never, depsFor('claude', parsed));
    expect(out).toHaveLength(1);
    expect(out[0].startEvent!.data.provider).toBe('native-external');
  });
});
```

> Match the existing `loadNativeSessions(filter, deps)` signature in this file; adjust the filter argument to whatever the surrounding tests already pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/__tests__/native-loader.test.ts -t "ownership gate"`
Expected: FAIL — `expected 'native-external' to be 'native'`

- [ ] **Step 3: Add `copilot-cli` to `NATIVE_AGENTS`**

`src/cli/commands/analytics/native-loader.ts:31`:

```ts
const NATIVE_AGENTS = ['claude', 'codex', 'copilot-cli'] as const;
```

- [ ] **Step 4: Exempt analytics-only agents from the gate**

Add near the top of `native-loader.ts`:

```ts
import { AgentRegistry } from '../../../agents/registry.js'; // if not already imported

/**
 * Agents CodeMie only reads analytics for and never installs, launches, or manages.
 *
 * The ownership gate exists to stop analytics silently counting UNMANAGED runs of an
 * agent CodeMie CAN manage (EPMCDME-13367). An analytics-only agent has no managed
 * variant, so it can never carry an ownership marker — applying the gate would drop
 * 100% of its sessions and make the integration a no-op.
 */
function isAnalyticsOnlyAgent(agentName: string): boolean {
  return AgentRegistry.getAgent(agentName)?.metadata.analyticsOnly === true;
}
```

Then change line 518 from:

```ts
    if (!deps.hasOwnershipMarker(descriptor.filePath) && raw.startEvent) {
      raw.startEvent.data.provider = 'native-external';
    }
```

to:

```ts
    if (
      !isAnalyticsOnlyAgent(agentName) &&
      !deps.hasOwnershipMarker(descriptor.filePath) &&
      raw.startEvent
    ) {
      raw.startEvent.data.provider = 'native-external';
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/__tests__/native-loader.test.ts`
Expected: PASS — including the pre-existing tests

- [ ] **Step 6: Verify end-to-end against real local data**

Run: `node dist/../bin/codemie.js analytics --report` (build first with `npm run build`)
Expected: Copilot sessions present **without** `--include-external`. Cross-check one session's cost against `phase0-spike.md` §5 — for the `gpt-5.2` entry the input component must be built from 381 719, not 14 076 695.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/native-loader.ts src/cli/commands/analytics/__tests__/
git commit -m "feat(analytics): discover copilot-cli sessions and exempt analytics-only agents from the ownership gate"
```

---

## Task 9: Report payload — premium requests and unpriced reasons

**Files:**
- Modify: `src/cli/commands/analytics/report/types.ts`
- Modify: `src/cli/commands/analytics/report/payload-builder.ts:59-90`
- Modify: `src/cli/commands/analytics/cost/types.ts` (carry the fields on `SessionCost`)
- Modify: `src/cli/commands/analytics/cost/cost-enricher.ts` (populate them)
- Test: `src/cli/commands/analytics/report/__tests__/payload-builder.test.ts` (extend)

**Interfaces:**
- Consumes: `extractCopilotUsage`'s `premiumRequests` / `partial` / `unavailableReason` (Task 3).
- Produces: optional `ReportSessionRecord` fields `premiumRequests?: number`, `usagePartial?: boolean`, `usageUnavailableReason?: string`.

**Test-first: yes** — a Copilot session with premium-request data emits `premiumRequests` in the payload; a session with no usage data emits `usageUnavailableReason`; a Claude session emits none of these fields.

- [ ] **Step 1: Write the failing test**

```ts
// src/cli/commands/analytics/report/__tests__/payload-builder.test.ts  (append)

describe('payload — copilot-cli specific fields', () => {
  it('carries premiumRequests and partial markers for copilot sessions', () => {
    // Build root/costIndex fixtures in the same style the surrounding tests use,
    // with a copilot-cli session whose SessionCost has premiumRequests: 3 and
    // usagePartial: true.
    const payload = buildPayload(root, costIndex, summary, ctx);
    const rec = payload.sessions.find((s) => s.sessionId === 'cp1')!;
    expect(rec.premiumRequests).toBe(3);
    expect(rec.usagePartial).toBe(true);
  });

  it('carries a reason for sessions with no usage data', () => {
    const payload = buildPayload(root, costIndex, summary, ctx);
    const rec = payload.sessions.find((s) => s.sessionId === 'cp-unpriced')!;
    expect(rec.usageUnavailableReason).toMatch(/no token telemetry/i);
    expect(rec.costUSD).toBe(0);
  });

  it('omits the copilot fields entirely for other agents', () => {
    const payload = buildPayload(root, costIndex, summary, ctx);
    const claude = payload.sessions.find((s) => s.agentName === 'claude')!;
    expect(claude.premiumRequests).toBeUndefined();
    expect(claude.usagePartial).toBeUndefined();
    expect(claude.usageUnavailableReason).toBeUndefined();
  });

  it('counts unpriced copilot sessions in AgentCoverage', () => {
    const payload = buildPayload(root, costIndex, summary, ctx);
    const cov = payload.meta.coverage.find((c) => c.agentName === 'copilot-cli')!;
    expect(cov.total).toBeGreaterThan(cov.priced);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts -t "copilot-cli specific fields"`
Expected: FAIL — `expected undefined to be 3`

- [ ] **Step 3: Extend the types**

`src/cli/commands/analytics/cost/types.ts` — add to `SessionCost`:

```ts
  /** Copilot CLI only: GitHub's actual billing unit for this session. */
  premiumRequests?: number;
  /** True when usage was reconstructed from per-turn events (output tokens only). */
  usagePartial?: boolean;
  /** Why this session could not be priced; absent when priced. */
  usageUnavailableReason?: string;
```

`src/cli/commands/analytics/report/types.ts` — add the same three optional fields to `ReportSessionRecord`.

- [ ] **Step 4: Populate them**

In `payload-builder.ts`, inside the `sessions.push({...})` literal (after `perModelCost`), spread conditionally so other agents' records are unchanged:

```ts
          ...(cost?.premiumRequests !== undefined ? { premiumRequests: cost.premiumRequests } : {}),
          ...(cost?.usagePartial ? { usagePartial: true } : {}),
          ...(cost?.usageUnavailableReason
            ? { usageUnavailableReason: cost.usageUnavailableReason }
            : {}),
```

In `cost-enricher.ts`, when the agent is `copilot-cli`, carry `premiumRequests`, `usagePartial`, and `usageUnavailableReason` from the parsed session onto the `SessionCost`. Surface them from `parseSessionFile` — add them to `ParsedSession.metadata` or a small adapter-specific field the enricher reads.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/payload-builder.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/analytics/report/ src/cli/commands/analytics/cost/
git commit -m "feat(analytics): surface copilot premium requests and unpriced reasons in the report payload"
```

---

## Task 10: Report UI — brand color, display label, and the detail modal

**Files:**
- Modify: `src/cli/commands/analytics/report/client/app.js:22` (colors + new label map), `:444` (compare table), `:1303` (agent chips), and the session-detail modal renderer
- Modify: `src/cli/commands/analytics/formatter.ts`
- Test: manual (see below)

**Interfaces:**
- Consumes: `ReportSessionRecord.premiumRequests` / `usagePartial` / `usageUnavailableReason` (Task 9).
- Produces: `labelFor(agent)` used at every site that renders an agent key.

**Test-first: no** — `app.js` is browser-side client code with no unit-test harness in this repo (`report-generator.test.ts` only asserts the bundle embeds it). Verify by generating a real report and inspecting it. If the reviewer wants automated coverage here, the right move is a `labelFor` unit test after extracting it — not a DOM harness.

- [ ] **Step 1: Add the color and the label map**

`src/cli/commands/analytics/report/client/app.js`, replacing line 22:

```js
  var AGENT_COLORS = { claude: '#7C5CFC', 'claude-acp': '#9D7BFF', 'claude-desktop': '#B79DFF', gemini: '#F5A534', codex: '#06B6D4', 'codemie-codex': '#06B6D4', opencode: '#259F4C', 'codemie-code': '#2297F6', 'copilot-cli': '#6E7681' };
  // Raw agent keys are internal ids; these are what a human should read. Unmapped
  // agents fall through to the key itself, so adding an agent here is optional.
  var AGENT_LABELS = { 'copilot-cli': 'GitHub Copilot CLI' };
  function labelFor(agent) { return AGENT_LABELS[agent] || agent; }
```

`#6E7681` is GitHub's neutral gray — the only unsaturated entry, so it reads as GitHub and cannot collide with an existing agent color or a `PALETTE` slot.

- [ ] **Step 2: Use the label in the agent chips**

At `app.js:1303`, change:

```js
      chip.innerHTML = '<span class="dot" style="background:' + colorFor(a) + '"></span>' + esc(a);
```

to:

```js
      chip.innerHTML = '<span class="dot" style="background:' + colorFor(a) + '"></span>' + esc(labelFor(a));
```

- [ ] **Step 3: Use the label in the Agents·Compare table**

At `app.js:444`, change the first cell from:

```js
        return ['<span class="tag tag-sm" style="text-transform:capitalize">' + esc(a) + '</span>', ...
```

to:

```js
        return ['<span class="tag tag-sm">' + esc(labelFor(a)) + '</span>', ...
```

Dropping `text-transform:capitalize` is deliberate — it would render the mapped label as "Github Copilot Cli". Other agents keep their existing appearance because their keys are already lowercase single words; if the reviewer wants the old capitalization preserved for unmapped agents, apply the style conditionally on `!AGENT_LABELS[a]`.

- [ ] **Step 4: Show the Copilot fields in the session-detail modal**

In the modal renderer (the function that reads `SESSION_BY_ID`), add — only when present, so no other agent's modal changes:

```js
    if (s.premiumRequests !== undefined) {
      rows.push(['Premium requests', fmtNum(s.premiumRequests)]);
    }
    if (s.usagePartial) {
      rows.push(['Usage', 'Partial — output tokens only (session did not record a full rollup)']);
    }
    if (s.usageUnavailableReason) {
      rows.push(['Usage', esc(s.usageUnavailableReason)]);
    }
```

Match the surrounding row-building style — if the modal builds HTML strings rather than a `rows` array, follow that instead.

- [ ] **Step 5: Use the label in terminal output**

In `formatter.ts`, wherever the agent name is printed in the per-agent breakdown, route it through a small server-side equivalent:

```ts
/** Human-readable agent labels for terminal output; unmapped agents render their key. */
const AGENT_LABELS: Record<string, string> = { 'copilot-cli': 'GitHub Copilot CLI' };

export function agentLabel(agentName: string): string {
  return AGENT_LABELS[agentName] ?? agentName;
}
```

- [ ] **Step 6: Verify manually**

```bash
npm run build
node bin/codemie.js analytics --report
```

Expected, with real Copilot sessions on disk:
1. An agent chip reading **GitHub Copilot CLI** in gray — not "Copilot-cli".
2. Copilot present in the Agents·Compare table, the cost doughnut, and the per-model breakdown.
3. Opening a Copilot session shows **Premium requests**.
4. A pre-`1.0` session appears with $0.00 and a usage reason rather than being absent.
5. No `--include-external` needed.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/analytics/report/client/app.js src/cli/commands/analytics/formatter.ts
git commit -m "feat(analytics): show GitHub Copilot CLI with brand color, label, and premium requests"
```

---

## Task 11: Full quality gate

**Files:** none — verification only.

**Test-first: n/a** — this task runs the repo's existing gates.

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: zero warnings (the repo has a zero-warning policy)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean

- [ ] **Step 4: Full test suite**

Run: `npm test`
Expected: PASS, no pre-existing tests broken

- [ ] **Step 5: Confirm the two high-risk guards are actually in the suite**

Run: `npx vitest run -t "cache decomposition"` and `npx vitest run -t "ownership gate"`
Expected: both PASS. If either reports "no tests found", the guard was lost in a rebase — restore it before proceeding.

- [ ] **Step 6: Commit any gate fixes**

```bash
git add -A
git commit -m "chore(analytics): satisfy quality gates for copilot-cli integration"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §1 data source → Tasks 1–2; §2 two-tier extraction → Task 3; §3 pricing/decomposition → Task 4; §4 plugin + adapter → Tasks 2, 6, 7; §5 ownership exemption → Task 8; §6 metrics + D11 skill invocations → Task 6; §7 analytics wiring → Tasks 5, 8; §8 report UI → Tasks 9, 10. D1 premium requests → Tasks 3, 9, 10. D2 unpriced-and-flagged → Tasks 3, 9, 10. D3 partial → Tasks 3, 9. D12 coverage counts → Task 9 (uses the existing `AgentCoverage`, no new mechanism).

**Edge cases from the spec** are covered as follows: `COPILOT_HOME` (Task 1 Step 4, Task 2 test), dirs with no `events.jsonl` (Task 2), malformed JSONL (Tasks 2, 6), mixed models (Tasks 3, 4), multiple `session.shutdown` (Task 3), `requests.cost: 0` (Task 3), large transcripts — discovery never opens one (Task 2), timezone/epoch conversion (Task 1).

**Known gaps, deliberately left to the implementer.** Task 9 Step 4 does not pin the exact plumbing that carries `premiumRequests` from `parseSessionFile` through `cost-enricher` onto `SessionCost`, because that seam depends on how the enricher accesses the parsed session — it must be settled by reading `cost-enricher.ts` at implementation time. Task 10 Step 4 leaves the modal row-building style to match whatever is there. Both are flagged inline rather than guessed.

**Type consistency.** `CopilotUsageMessage` (Task 3) is the shape `readCopilotCli` destructures (Task 4) and the shape `parseSessionFile` puts in `messages` (Task 6) — `{ model, usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens}, requests?, partial? }`, consistent across all three. `CopilotCliPluginMetadata` is exported from `copilot-cli.plugin.ts` (Task 2) and imported by the Task 2, 3, and 6 tests. `analyticsOnly` is added to `AgentMetadata` in Task 2 and read in Tasks 7 and 8.

**Ordering.** Each task is independently verifiable: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Tasks 4 and 5 depend only on the message shape from Task 3, not on the adapter, so they can be verified against hand-written fixtures.
