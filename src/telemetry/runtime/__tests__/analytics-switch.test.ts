import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '@/agents/core/session/types.js';
import { AnalyticsSwitch, claudeAnalyticsCollecting, readClaudeAnalyticsSwitch } from '../analytics-switch.js';

describe('analytics switch', () => {
  let codemieHome: string;

  beforeEach(() => {
    codemieHome = mkdtempSync(join(tmpdir(), 'analytics-switch-'));
    vi.stubEnv('CODEMIE_HOME', codemieHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(codemieHome, { recursive: true, force: true });
  });

  function writePreferences(content: string): void {
    writeFileSync(join(codemieHome, 'claude-analytics.json'), content);
  }

  it('is on when the file is missing', async () => {
    expect(await readClaudeAnalyticsSwitch()).toBe('on');
    expect(await claudeAnalyticsCollecting()).toBe(true);
  });

  it('is on with enabled: true', async () => {
    writePreferences(JSON.stringify({ enabled: true }));
    expect(await readClaudeAnalyticsSwitch()).toBe('on');
    expect(await claudeAnalyticsCollecting()).toBe(true);
  });

  it('is off with enabled: false', async () => {
    writePreferences(JSON.stringify({ enabled: false }));
    expect(await readClaudeAnalyticsSwitch()).toBe('off');
    expect(await claudeAnalyticsCollecting()).toBe(false);
  });

  it('is corrupt for an unparsable file and does not collect', async () => {
    writePreferences('not json');
    expect(await readClaudeAnalyticsSwitch()).toBe('corrupt');
    expect(await claudeAnalyticsCollecting()).toBe(false);
  });

  describe('the forward-only checkpoint fields of a known record', () => {
    const delivery = { closeLiveRecordsLocally: vi.fn(async () => true) };
    const record = (checkpoint: Partial<NonNullable<Session['runtimeCheckpoint']>>): Session => ({
      sessionId: 'record-1',
      runtimeCheckpoint: { externalSessionId: 'ext-1', transcriptPath: '/t.jsonl', lastDiscoveredAt: 1, ...checkpoint }
    }) as Session;

    it('adopts the current generation without a rebase for a record that predates the stamp', async () => {
      writePreferences(JSON.stringify({ enabled: true, collectionGeneration: 3 }));
      const gate = new AnalyticsSwitch();
      await gate.check(1_000, new Map(), delivery);

      expect(gate.checkpointFields(record({}))).toEqual({ collectionGeneration: 3 });
    });

    it('rebases a record stamped with another generation to the time this daemon first saw the current one', async () => {
      writePreferences(JSON.stringify({ enabled: true, collectionGeneration: 3 }));
      const gate = new AnalyticsSwitch();
      await gate.check(1_000, new Map(), delivery);

      expect(gate.checkpointFields(record({ collectionGeneration: 1 }))).toEqual({ baselineCutoffMs: 1_000, collectionGeneration: 3 });
      expect(gate.checkpointFields(record({ collectionGeneration: 3 }))).toEqual({ collectionGeneration: 3 });
    });

    it('keeps a pending baseline that is later than the cutoff', async () => {
      writePreferences(JSON.stringify({ enabled: true, collectionGeneration: 3 }));
      const gate = new AnalyticsSwitch();
      await gate.check(1_000, new Map(), delivery);

      expect(gate.checkpointFields(record({ collectionGeneration: 1, baselineCutoffMs: 1_500 }))).toMatchObject({ baselineCutoffMs: 1_500 });
    });
  });
});
