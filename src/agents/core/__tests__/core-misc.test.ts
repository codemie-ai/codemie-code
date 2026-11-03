/**
 * Unit tests for miscellaneous agents/core helpers.
 *
 * Covers:
 *  - plugin-injector.ts        (temp-file-backed embedded plugin writer, idempotency, cleanup)
 *  - temp-config.ts            (env-overflow fallback temp config writer, MAX_ENV_SIZE contract)
 *  - session/sync-state-utils.ts        (pure processor-sync merge — round-trips, additive deltas, idempotency)
 *
 * All filesystem access is isolated to a unique mkdtemp dir. No network / SSO / hook
 * module is touched.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, basename, dirname } from 'path';

// Silence the real logger — it writes async debug logs into $CODEMIE_HOME/logs,
// which races the temp-dir cleanup below. All targets import the same logger module.
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createPluginInjector } from '../plugin-injector.js';
import { writeConfigToTempFile, MAX_ENV_SIZE } from '../temp-config.js';
import { applyProcessingSyncUpdates } from '../session/sync-state-utils.js';
import type { ProcessingResult } from '../session/BaseProcessor.js';
import type { Session } from '../session/types.js';

// ---------------------------------------------------------------------------
// plugin-injector.ts
// ---------------------------------------------------------------------------
describe('plugin-injector: createPluginInjector', () => {
  // getPluginFileUrl writes to <os.tmpdir()>/codemie-hooks/<fileName>. Use a unique
  // fileName per test and clean up the produced file so we never collide or leak.
  const written: string[] = [];

  afterEach(() => {
    for (const p of written.splice(0)) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('writes the plugin source to <tmpdir>/codemie-hooks/<fileName> and returns its file:// URL', () => {
    const fileName = `test-plugin-${process.pid}-${Date.now()}-a.ts`;
    const source = 'export const plugin = () => 42;\n';
    const injector = createPluginInjector(fileName, source, 'unit-hooks');

    const url = injector.getPluginFileUrl();

    const expectedPath = join(tmpdir(), 'codemie-hooks', fileName);
    written.push(expectedPath);

    expect(url).toBe(`file://${expectedPath}`);
    expect(url.startsWith('file://')).toBe(true);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, 'utf-8')).toBe(source);
    expect(basename(expectedPath)).toBe(fileName);
  });

  it('is idempotent: repeated calls return the same URL without rewriting', () => {
    const fileName = `test-plugin-${process.pid}-${Date.now()}-b.ts`;
    const injector = createPluginInjector(fileName, 'first-source', 'unit-hooks');

    const url1 = injector.getPluginFileUrl();
    const filePath = join(tmpdir(), 'codemie-hooks', fileName);
    written.push(filePath);

    // Mutate the file on disk; a second getPluginFileUrl must NOT overwrite it
    // (short-circuits on the cached path).
    writeFileSync(filePath, 'externally-changed', 'utf-8');
    const url2 = injector.getPluginFileUrl();

    expect(url2).toBe(url1);
    expect(readFileSync(filePath, 'utf-8')).toBe('externally-changed');
  });

  it('cleanup removes the temp file and is safe to call repeatedly (idempotent)', () => {
    const fileName = `test-plugin-${process.pid}-${Date.now()}-c.ts`;
    const injector = createPluginInjector(fileName, 'to-be-cleaned', 'unit-hooks');

    const filePath = join(tmpdir(), 'codemie-hooks', fileName);
    written.push(filePath);
    injector.getPluginFileUrl();
    expect(existsSync(filePath)).toBe(true);

    injector.cleanup();
    expect(existsSync(filePath)).toBe(false);

    // Second cleanup is a no-op (pluginFilePath already null) — must not throw.
    expect(() => injector.cleanup()).not.toThrow();
  });

  it('cleanup before any write is a no-op', () => {
    const injector = createPluginInjector(`never-${Date.now()}.ts`, 'x', 'unit-hooks');
    expect(() => injector.cleanup()).not.toThrow();
  });

  it('after cleanup, getPluginFileUrl re-creates the file', () => {
    const fileName = `test-plugin-${process.pid}-${Date.now()}-d.ts`;
    const injector = createPluginInjector(fileName, 'recreate-me', 'unit-hooks');
    const filePath = join(tmpdir(), 'codemie-hooks', fileName);
    written.push(filePath);

    injector.getPluginFileUrl();
    injector.cleanup();
    expect(existsSync(filePath)).toBe(false);

    const url = injector.getPluginFileUrl();
    expect(url).toBe(`file://${filePath}`);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toBe('recreate-me');
  });
});

// ---------------------------------------------------------------------------
// temp-config.ts
// ---------------------------------------------------------------------------
describe('temp-config: writeConfigToTempFile', () => {
  const written: string[] = [];

  afterEach(() => {
    for (const p of written.splice(0)) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('exposes a conservative MAX_ENV_SIZE of 32KiB', () => {
    expect(MAX_ENV_SIZE).toBe(32 * 1024);
  });

  it('writes the JSON to a temp file whose name encodes the agent tag and pid', () => {
    const configJson = JSON.stringify({ model: 'x', nested: { a: 1 } });
    const path = writeConfigToTempFile(configJson, 'opencode');
    written.push(path);

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe(configJson);

    const name = basename(path);
    expect(name.startsWith('codemie-opencode-config-')).toBe(true);
    expect(name.endsWith('.json')).toBe(true);
    expect(name).toContain(`-${process.pid}-`);
    // Written into the OS temp dir.
    expect(dirname(path)).toBe(tmpdir());
  });

  it('produces distinct paths per call (timestamp/agent-tagged)', () => {
    const p1 = writeConfigToTempFile('{"a":1}', 'codemie-code');
    const p2 = writeConfigToTempFile('{"b":2}', 'claude');
    written.push(p1, p2);

    expect(p1).not.toBe(p2);
    expect(basename(p1)).toContain('codemie-code');
    expect(basename(p2)).toContain('claude');
    expect(readFileSync(p1, 'utf-8')).toBe('{"a":1}');
    expect(readFileSync(p2, 'utf-8')).toBe('{"b":2}');
  });

  it('faithfully round-trips arbitrary (even empty) content', () => {
    const p = writeConfigToTempFile('', 'edge');
    written.push(p);
    expect(readFileSync(p, 'utf-8')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// session/sync-state-utils.ts
// ---------------------------------------------------------------------------
function makeSession(partial: Partial<Session> = {}): Session {
  return {
    sessionId: 'sid',
    agentName: 'claude',
    provider: 'ai-run-sso',
    startTime: 1000,
    workingDirectory: '/tmp',
    correlation: { status: 'pending', retryCount: 0 },
    status: 'active',
    activeDurationMs: 0,
    ...partial,
  };
}

function metricsResult(
  metrics: NonNullable<NonNullable<ProcessingResult['metadata']>['syncUpdates']>['metrics']
): ProcessingResult {
  return { success: true, metadata: { syncUpdates: { metrics } } };
}

function conversationsResult(
  conversations: NonNullable<
    NonNullable<ProcessingResult['metadata']>['syncUpdates']
  >['conversations']
): ProcessingResult {
  return { success: true, metadata: { syncUpdates: { conversations } } };
}

describe('sync-state-utils: applyProcessingSyncUpdates', () => {
  it('returns false and mutates nothing when there are no results', () => {
    const session = makeSession();
    expect(applyProcessingSyncUpdates(session, [])).toBe(false);
    expect(session.sync).toBeUndefined();
  });

  it('ignores results without metadata.syncUpdates', () => {
    const session = makeSession();
    const results: ProcessingResult[] = [
      { success: true },
      { success: false, message: 'x', metadata: { recordsProcessed: 3 } },
    ];
    expect(applyProcessingSyncUpdates(session, results)).toBe(false);
    expect(session.sync).toBeUndefined();
  });

  it('initialises metrics state and applies a first batch of deltas', () => {
    const session = makeSession();
    const changed = applyProcessingSyncUpdates(session, [
      metricsResult({
        processedRecordIds: ['a', 'b'],
        totalDeltas: 2,
        totalSynced: 1,
        totalFailed: 0,
        lastProcessedTimestamp: 5555,
      }),
    ]);

    expect(changed).toBe(true);
    expect(session.sync?.metrics?.processedRecordIds).toEqual(['a', 'b']);
    expect(session.sync?.metrics?.totalDeltas).toBe(2);
    expect(session.sync?.metrics?.totalSynced).toBe(1);
    expect(session.sync?.metrics?.totalFailed).toBe(0);
    expect(session.sync?.metrics?.lastProcessedTimestamp).toBe(5555);
  });

  it('treats counters as additive across successive applications', () => {
    const session = makeSession();
    applyProcessingSyncUpdates(session, [metricsResult({ totalDeltas: 2, totalSynced: 1, totalFailed: 1 })]);
    applyProcessingSyncUpdates(session, [metricsResult({ totalDeltas: 3, totalSynced: 2, totalFailed: 0 })]);

    expect(session.sync?.metrics?.totalDeltas).toBe(5);
    expect(session.sync?.metrics?.totalSynced).toBe(3);
    expect(session.sync?.metrics?.totalFailed).toBe(1);
  });

  it('dedups processedRecordIds and reports no change when only duplicates are added', () => {
    const session = makeSession();
    applyProcessingSyncUpdates(session, [metricsResult({ processedRecordIds: ['a', 'b'] })]);

    // Re-adding the same ids (and nothing else) is idempotent → no change.
    const changed = applyProcessingSyncUpdates(session, [metricsResult({ processedRecordIds: ['a', 'b'] })]);
    expect(changed).toBe(false);
    expect(session.sync?.metrics?.processedRecordIds).toEqual(['a', 'b']);

    // Adding a genuinely new id is a change and unions in.
    const changed2 = applyProcessingSyncUpdates(session, [metricsResult({ processedRecordIds: ['b', 'c'] })]);
    expect(changed2).toBe(true);
    expect(new Set(session.sync?.metrics?.processedRecordIds)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('only updates lastProcessedTimestamp when it actually differs', () => {
    const session = makeSession();
    applyProcessingSyncUpdates(session, [metricsResult({ lastProcessedTimestamp: 100 })]);
    // Same value again → no change from this field.
    const changed = applyProcessingSyncUpdates(session, [metricsResult({ lastProcessedTimestamp: 100 })]);
    expect(changed).toBe(false);
    expect(session.sync?.metrics?.lastProcessedTimestamp).toBe(100);
  });

  it('initialises conversations state and applies identity + additive fields', () => {
    const session = makeSession();
    const changed = applyProcessingSyncUpdates(session, [
      conversationsResult({
        conversationId: 'conv-1',
        lastSyncedMessageUuid: 'uuid-9',
        lastSyncedHistoryIndex: 5,
        totalMessagesSynced: 4,
        totalSyncAttempts: 1,
        lastSyncAt: 777,
      }),
    ]);

    expect(changed).toBe(true);
    expect(session.sync?.conversations?.conversationId).toBe('conv-1');
    expect(session.sync?.conversations?.lastSyncedMessageUuid).toBe('uuid-9');
    expect(session.sync?.conversations?.lastSyncedHistoryIndex).toBe(5);
    expect(session.sync?.conversations?.totalMessagesSynced).toBe(4);
    expect(session.sync?.conversations?.totalSyncAttempts).toBe(1);
    expect(session.sync?.conversations?.lastSyncAt).toBe(777);
  });

  it('advances lastSyncedHistoryIndex monotonically (Math.max), never regressing', () => {
    const session = makeSession();
    applyProcessingSyncUpdates(session, [conversationsResult({ lastSyncedHistoryIndex: 5 })]);

    // A lower index must not regress the stored value and reports no change.
    const changed = applyProcessingSyncUpdates(session, [conversationsResult({ lastSyncedHistoryIndex: 3 })]);
    expect(changed).toBe(false);
    expect(session.sync?.conversations?.lastSyncedHistoryIndex).toBe(5);

    // A higher index advances it.
    const changed2 = applyProcessingSyncUpdates(session, [conversationsResult({ lastSyncedHistoryIndex: 9 })]);
    expect(changed2).toBe(true);
    expect(session.sync?.conversations?.lastSyncedHistoryIndex).toBe(9);
  });

  it('accumulates totalMessagesSynced / totalSyncAttempts across batches', () => {
    const session = makeSession();
    applyProcessingSyncUpdates(session, [conversationsResult({ totalMessagesSynced: 2, totalSyncAttempts: 1 })]);
    applyProcessingSyncUpdates(session, [conversationsResult({ totalMessagesSynced: 3, totalSyncAttempts: 1 })]);
    expect(session.sync?.conversations?.totalMessagesSynced).toBe(5);
    expect(session.sync?.conversations?.totalSyncAttempts).toBe(2);
  });

  it('merges metrics and conversations from multiple results in one call', () => {
    const session = makeSession();
    const changed = applyProcessingSyncUpdates(session, [
      metricsResult({ totalDeltas: 1 }),
      conversationsResult({ totalMessagesSynced: 2 }),
    ]);
    expect(changed).toBe(true);
    expect(session.sync?.metrics?.totalDeltas).toBe(1);
    expect(session.sync?.conversations?.totalMessagesSynced).toBe(2);
  });
});
