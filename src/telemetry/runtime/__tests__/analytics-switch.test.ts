import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
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

  describe('AnalyticsSwitch.check', () => {
    it('collects while on and not while off', async () => {
      const gate = new AnalyticsSwitch();
      expect(await gate.check()).toBe(true);

      writePreferences(JSON.stringify({ enabled: false }));
      expect(await gate.check()).toBe(false);

      writePreferences(JSON.stringify({ enabled: true }));
      expect(await gate.check()).toBe(true);
    });

    it('does not collect while the file is corrupt and resumes when it reads valid', async () => {
      const gate = new AnalyticsSwitch();
      writePreferences('not json');
      expect(await gate.check()).toBe(false);

      writePreferences(JSON.stringify({ enabled: true }));
      expect(await gate.check()).toBe(true);
    });
  });
});
