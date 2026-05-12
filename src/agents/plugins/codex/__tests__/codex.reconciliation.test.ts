import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  findStaleCodexSessions,
  reconcileStaleCodexSessions,
} from '../codex.reconciliation.js';
import type { Session } from '../../../core/session/types.js';
import type { HookProcessingConfig } from '../../../../cli/commands/hook.js';

const ORIGINAL_CODEMIE_HOME = process.env.CODEMIE_HOME;

let tempHome: string;
let sessionsDir: string;

const NOW = 1_000_000_000_000;
const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

async function writeSession(name: string, session: Session): Promise<void> {
  await writeFile(join(sessionsDir, `${name}.json`), JSON.stringify(session, null, 2));
}

function makeSession(overrides: Partial<Session>): Session {
  return {
    sessionId: overrides.sessionId ?? 'unset',
    agentName: overrides.agentName ?? 'codex',
    provider: overrides.provider ?? 'ai-run-sso',
    startTime: overrides.startTime ?? NOW - 2 * HOUR_MS,
    workingDirectory: overrides.workingDirectory ?? '/tmp/work',
    correlation: overrides.correlation ?? { status: 'matched', retryCount: 0 },
    status: overrides.status ?? 'active',
    activeDurationMs: overrides.activeDurationMs ?? 0,
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'codemie-recon-'));
  sessionsDir = join(tempHome, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  process.env.CODEMIE_HOME = tempHome;
});

afterEach(() => {
  if (ORIGINAL_CODEMIE_HOME === undefined) {
    delete process.env.CODEMIE_HOME;
  } else {
    process.env.CODEMIE_HOME = ORIGINAL_CODEMIE_HOME;
  }
});

describe('findStaleCodexSessions', () => {
  it('returns codex sessions that are active and inactive past the threshold', async () => {
    await writeSession('stale', makeSession({
      sessionId: 'stale',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 45 * MIN_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale.map((s) => s.sessionId)).toEqual(['stale']);
  });

  it('excludes sessions whose last activity is within the threshold', async () => {
    await writeSession('fresh', makeSession({
      sessionId: 'fresh',
      status: 'active',
      startTime: NOW - HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 5 * MIN_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale).toEqual([]);
  });

  it('excludes sessions that are already completed', async () => {
    await writeSession('done', makeSession({
      sessionId: 'done',
      status: 'completed',
      startTime: NOW - 2 * HOUR_MS,
      endTime: NOW - HOUR_MS,
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale).toEqual([]);
  });

  it('excludes sessions belonging to other agents', async () => {
    await writeSession('claude-stale', makeSession({
      sessionId: 'claude-stale',
      agentName: 'claude',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 2 * HOUR_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale).toEqual([]);
  });

  it('excludes sessions whose start time is older than the lookback window', async () => {
    await writeSession('ancient', makeSession({
      sessionId: 'ancient',
      status: 'active',
      startTime: NOW - 48 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 47 * HOUR_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const stale = await findStaleCodexSessions({ now: NOW, maxLookbackMs: 24 * HOUR_MS });

    expect(stale).toEqual([]);
  });

  it('uses startTime as fallback when no sync activity is recorded', async () => {
    await writeSession('startup-stalled', makeSession({
      sessionId: 'startup-stalled',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      // no sync block
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale.map((s) => s.sessionId)).toEqual(['startup-stalled']);
  });

  it('skips files prefixed with completed_ even if their content looks active', async () => {
    await writeSession('completed_old', makeSession({
      sessionId: 'old',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 2 * HOUR_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const stale = await findStaleCodexSessions({ now: NOW });

    expect(stale).toEqual([]);
  });
});

describe('reconcileStaleCodexSessions', () => {
  it('invokes processEvent with reason=interrupted for each stale session', async () => {
    await writeSession('s1', makeSession({
      sessionId: 's1',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 45 * MIN_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));
    await writeSession('s2', makeSession({
      sessionId: 's2',
      status: 'active',
      startTime: NOW - 3 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 60 * MIN_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const calls: Array<{ sessionId: string; reason?: string }> = [];

    const result = await reconcileStaleCodexSessions(
      {} as NodeJS.ProcessEnv,
      () => ({ agentName: 'codex', sessionId: 'unused', clientType: 'codemie-codex' } as HookProcessingConfig),
      {
        now: NOW,
        processEvent: async (event) => {
          calls.push({
            sessionId: event.session_id,
            reason: (event as { reason?: string }).reason,
          });
        },
      },
    );

    expect(result).toEqual({ reconciled: 2, failed: 0 });
    expect(calls.map((c) => c.sessionId).sort()).toEqual(['s1', 's2']);
    expect(calls.every((c) => c.reason === 'interrupted')).toBe(true);
  });

  it('counts failures separately when processEvent throws', async () => {
    await writeSession('boom', makeSession({
      sessionId: 'boom',
      status: 'active',
      startTime: NOW - 2 * HOUR_MS,
      sync: {
        metrics: {
          lastProcessedTimestamp: NOW - 45 * MIN_MS,
          processedRecordIds: [],
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0,
        },
      },
    }));

    const result = await reconcileStaleCodexSessions(
      {} as NodeJS.ProcessEnv,
      () => ({ agentName: 'codex', sessionId: 'unused', clientType: 'codemie-codex' } as HookProcessingConfig),
      {
        now: NOW,
        processEvent: async () => {
          throw new Error('boom');
        },
      },
    );

    expect(result).toEqual({ reconciled: 0, failed: 1 });
  });

  it('returns zero counts when no stale sessions exist', async () => {
    const result = await reconcileStaleCodexSessions(
      {} as NodeJS.ProcessEnv,
      () => ({ agentName: 'codex', sessionId: 'unused', clientType: 'codemie-codex' } as HookProcessingConfig),
      {
        now: NOW,
        processEvent: async () => {
          throw new Error('should not be called');
        },
      },
    );

    expect(result).toEqual({ reconciled: 0, failed: 0 });
  });
});
