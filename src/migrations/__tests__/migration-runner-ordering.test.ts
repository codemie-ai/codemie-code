/**
 * Migration ORCHESTRATION coverage — MigrationRunner.runPending + MigrationRegistry
 * + MigrationTracker working together. The individual migrations (001–007) are
 * tested elsewhere; here we pin the runner/registry/tracker contract that decides
 * WHICH migrations run, in what ORDER, and how history is persisted so a second
 * run is a no-op.
 *
 * ISOLATION / SAFETY
 * ------------------
 * MigrationTracker.HISTORY_FILE is a STATIC readonly computed from
 * getCodemiePath('migrations.json') at module-load time. To bind it to a private
 * temp dir per test we:
 *   1. set CODEMIE_HOME to a fresh mkdtemp dir BEFORE importing the modules,
 *   2. vi.resetModules() so runner/registry/tracker are re-evaluated together,
 *   3. dynamic-import all three from the SAME fresh module graph so they share
 *      one MigrationRegistry / one HISTORY_FILE.
 * The registry starts empty in each fresh graph, so we register only FAKE
 * in-memory migrations — the real 001–007 never run and no real config is
 * touched. CODEMIE_HOME is restored and the temp dir removed in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Migration, MigrationResult } from '../types.js';

let tmpHome: string;
let originalCodemieHome: string | undefined;
// Loggers created inside each fresh module graph — closed before the temp dir is
// removed so their async debug-log writes cannot ENOENT against a deleted dir.
let openLoggers: Array<{ close: () => Promise<void> }> = [];

// Load a FRESH module graph bound to the current CODEMIE_HOME.
async function loadFresh(): Promise<{
  MigrationRunner: typeof import('../runner.js').MigrationRunner;
  MigrationRegistry: typeof import('../registry.js').MigrationRegistry;
  MigrationTracker: typeof import('../tracker.js').MigrationTracker;
}> {
  vi.resetModules();
  const [{ MigrationRunner }, { MigrationRegistry }, { MigrationTracker }, { logger }] =
    await Promise.all([
      import('../runner.js'),
      import('../registry.js'),
      import('../tracker.js'),
      import('../../utils/logger.js'),
    ]);
  openLoggers.push(logger);
  return { MigrationRunner, MigrationRegistry, MigrationTracker };
}

// Build an in-memory fake migration whose up() records its invocation order.
function fakeMigration(
  id: string,
  result: MigrationResult | (() => never),
  callLog?: string[],
  extra?: Partial<Migration>,
): Migration {
  return {
    id,
    description: `fake ${id}`,
    ...extra,
    async up(): Promise<MigrationResult> {
      callLog?.push(id);
      if (typeof result === 'function') {
        result(); // throws
      }
      return result as MigrationResult;
    },
  };
}

const OK: MigrationResult = { success: true, migrated: true, details: { ok: 1 } };

beforeEach(() => {
  originalCodemieHome = process.env.CODEMIE_HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'codemie-mig-runner-'));
  process.env.CODEMIE_HOME = tmpHome;
});

afterEach(async () => {
  // Flush + close every logger stream opened in this test's temp dir first, so no
  // pending async write races the directory removal below.
  await Promise.all(openLoggers.map(l => l.close().catch(() => undefined)));
  openLoggers = [];
  if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
  else delete process.env.CODEMIE_HOME;
  // Windows can still hold log file handles briefly after stream.end(); force +
  // maxRetries only suppress ENOENT, so treat residual ENOTEMPTY/EBUSY as
  // best-effort teardown (matches claude.metrics-processor-names.test.ts).
  try {
    rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* ignore temp-dir cleanup races */
  }
  vi.restoreAllMocks();
});

// ── Registry: register / ordering / get / clear ───────────────────────────────
describe('MigrationRegistry', () => {
  it('getAll() returns migrations sorted by id regardless of registration order', async () => {
    const { MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(fakeMigration('003-c', OK));
    MigrationRegistry.register(fakeMigration('001-a', OK));
    MigrationRegistry.register(fakeMigration('002-b', OK));

    expect(MigrationRegistry.getAll().map(m => m.id)).toEqual(['001-a', '002-b', '003-c']);
  });

  it('get() finds a migration by id, and returns undefined for unknown ids', async () => {
    const { MigrationRegistry } = await loadFresh();
    const m = fakeMigration('010-x', OK);
    MigrationRegistry.register(m);

    expect(MigrationRegistry.get('010-x')).toBe(m);
    expect(MigrationRegistry.get('nope')).toBeUndefined();
  });

  it('clear() empties the registry', async () => {
    const { MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(fakeMigration('001-a', OK));
    MigrationRegistry.clear();
    expect(MigrationRegistry.getAll()).toEqual([]);
  });
});

// ── runPending: ordering + selecting only un-recorded migrations ──────────────
describe('MigrationRunner.runPending — ordering & selection', () => {
  it('runs every pending migration once, in id-sorted order', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    const calls: string[] = [];
    // Registered out of order on purpose.
    MigrationRegistry.register(fakeMigration('002-b', OK, calls));
    MigrationRegistry.register(fakeMigration('003-c', OK, calls));
    MigrationRegistry.register(fakeMigration('001-a', OK, calls));

    const stats = await MigrationRunner.runPending({ silent: true });

    expect(calls).toEqual(['001-a', '002-b', '003-c']);
    expect(stats).toEqual({ total: 3, applied: 3, skipped: 0, failed: 0 });
  });

  it('returns zeros and touches nothing when the registry is empty', async () => {
    const { MigrationRunner } = await loadFresh();
    const stats = await MigrationRunner.runPending({ silent: true });
    expect(stats).toEqual({ total: 0, applied: 0, skipped: 0, failed: 0 });
    // No history file is written when there is nothing to do.
    expect(existsSync(join(tmpHome, 'migrations.json'))).toBe(false);
  });

  it('skips migrations already recorded in history and runs only the rest', async () => {
    const { MigrationRunner, MigrationRegistry, MigrationTracker } = await loadFresh();
    MigrationRegistry.register(fakeMigration('001-a', OK));
    MigrationRegistry.register(fakeMigration('002-b', OK));
    // Pre-record 001-a as already applied.
    await MigrationTracker.recordMigration('001-a', true);

    const calls: string[] = [];
    // Re-register with a shared call log to observe which up() actually runs.
    MigrationRegistry.clear();
    MigrationRegistry.register(fakeMigration('001-a', OK, calls));
    MigrationRegistry.register(fakeMigration('002-b', OK, calls));

    const stats = await MigrationRunner.runPending({ silent: true });

    expect(calls).toEqual(['002-b']);
    expect(stats.total).toBe(1);
    expect(stats.applied).toBe(1);
  });
});

// ── Idempotency: history is persisted, second run is a no-op ───────────────────
describe('MigrationRunner.runPending — idempotency & persistence', () => {
  it('records applied migrations so a second runPending does nothing', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    const calls: string[] = [];
    MigrationRegistry.register(fakeMigration('001-a', OK, calls));
    MigrationRegistry.register(fakeMigration('002-b', OK, calls));

    const first = await MigrationRunner.runPending({ silent: true });
    expect(first.applied).toBe(2);

    // History file now exists with both ids recorded as success.
    const hist = JSON.parse(readFileSync(join(tmpHome, 'migrations.json'), 'utf-8'));
    expect(hist.migrations.map((m: any) => m.id).sort()).toEqual(['001-a', '002-b']);
    expect(hist.migrations.every((m: any) => m.success === true)).toBe(true);

    const second = await MigrationRunner.runPending({ silent: true });
    expect(second).toEqual({ total: 0, applied: 0, skipped: 0, failed: 0 });
    // up() was NOT called again on the second run.
    expect(calls).toEqual(['001-a', '002-b']);
    expect(await MigrationRunner.hasPending()).toBe(false);
  });

  it('records a skipped (migrated:false) migration too, so it does not re-run', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(
      fakeMigration('001-a', { success: true, migrated: false, reason: 'already-done' }),
    );

    const stats = await MigrationRunner.runPending({ silent: true });
    expect(stats).toEqual({ total: 1, applied: 0, skipped: 1, failed: 0 });

    // Recorded despite being skipped → prevents re-running.
    const hist = JSON.parse(readFileSync(join(tmpHome, 'migrations.json'), 'utf-8'));
    expect(hist.migrations).toHaveLength(1);
    expect(hist.migrations[0].id).toBe('001-a');
    expect(await MigrationRunner.hasPending()).toBe(false);
  });

  it('dryRun applies logic but records nothing, so migrations stay pending', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(fakeMigration('001-a', OK));

    const stats = await MigrationRunner.runPending({ silent: true, dryRun: true });
    expect(stats.applied).toBe(1);
    // No history written in dry-run mode.
    expect(existsSync(join(tmpHome, 'migrations.json'))).toBe(false);
    expect(await MigrationRunner.hasPending()).toBe(true);
  });
});

// ── Failure handling: does NOT corrupt the tracker, other migrations continue ──
describe('MigrationRunner.runPending — failure handling', () => {
  it('a migration returning success:false is counted failed and NOT recorded (retryable)', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(
      fakeMigration('001-a', { success: false, migrated: false, reason: 'boom' }),
    );

    const stats = await MigrationRunner.runPending({ silent: true });
    expect(stats).toEqual({ total: 1, applied: 0, skipped: 0, failed: 1 });
    // Failure is not persisted → still pending on next run.
    expect(existsSync(join(tmpHome, 'migrations.json'))).toBe(false);
    expect(await MigrationRunner.hasPending()).toBe(true);
  });

  it('a migration whose up() THROWS is caught, counted failed, and not recorded', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    MigrationRegistry.register(
      fakeMigration('001-a', () => {
        throw new Error('kaboom');
      }),
    );

    const stats = await MigrationRunner.runPending({ silent: true });
    expect(stats.failed).toBe(1);
    expect(stats.applied).toBe(0);
    expect(existsSync(join(tmpHome, 'migrations.json'))).toBe(false);
  });

  it('a failing middle migration does NOT stop later ones; only the failure stays pending', async () => {
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    const calls: string[] = [];
    MigrationRegistry.register(fakeMigration('001-a', OK, calls));
    MigrationRegistry.register(
      fakeMigration('002-b', () => {
        throw new Error('mid failure');
      }, calls),
    );
    MigrationRegistry.register(fakeMigration('003-c', OK, calls));

    const stats = await MigrationRunner.runPending({ silent: true });

    // Runner continued past the failure — all three up()s were attempted in order.
    expect(calls).toEqual(['001-a', '002-b', '003-c']);
    expect(stats).toEqual({ total: 3, applied: 2, skipped: 0, failed: 1 });

    // Only the two successes were recorded; the failure is left pending.
    const hist = JSON.parse(readFileSync(join(tmpHome, 'migrations.json'), 'utf-8'));
    expect(hist.migrations.map((m: any) => m.id).sort()).toEqual(['001-a', '003-c']);

    const pending = await MigrationTrackerPending(MigrationRegistry);
    expect(pending).toEqual(['002-b']);
  });
});

// Helper: recompute pending ids from the runner's perspective for the assertion above.
async function MigrationTrackerPending(
  registry: typeof import('../registry.js').MigrationRegistry,
): Promise<string[]> {
  // getPendingMigrations lives on the tracker in the same fresh graph; import it here.
  const { MigrationTracker } = await import('../tracker.js');
  const pending = await MigrationTracker.getPendingMigrations();
  // Silence unused-registry warning; registry is used implicitly via tracker.
  void registry;
  return pending.map(m => m.id);
}

// ── Scheduling is purely id/tracker-based — there is no version gating ─────────
describe('MigrationRunner.runPending — no version gating', () => {
  it('schedules solely by recorded id (the vestigial minVersion field was removed)', async () => {
    // minVersion used to be declared on the Migration interface but was never
    // consulted; it has been removed. Whether a migration runs is decided ONLY by
    // whether the tracker has already recorded its id.
    const { MigrationRunner, MigrationRegistry } = await loadFresh();
    const calls: string[] = [];
    MigrationRegistry.register(fakeMigration('001-anything', OK, calls));

    const stats = await MigrationRunner.runPending({ silent: true });

    expect(calls).toEqual(['001-anything']);
    expect(stats.applied).toBe(1);
  });
});
