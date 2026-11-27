import { describe, expect, it, vi } from 'vitest';
import { backendCollection } from '../backend.js';
import { BackendPolicy } from '@/agents/core/collection-policy.js';
import { ReportSource } from '../../../analytics/sync/report-builder.js';
import { ensureOtlpProxy } from '../../../proxy/otlp-cold-start.js';
import { startProxy } from '../../../proxy/start.js';
import { restartProxy } from '../../../proxy/restart.js';
import { PROXY_DOCTOR_GROUPS } from '../../../proxy/doctor/groups.js';
import type { DaemonState } from '../../../proxy/daemon-manager.js';

const STATE = { pid: 1, port: 4001, url: 'http://127.0.0.1:4001', profile: 'work', gatewayKey: 'gk' } as DaemonState;

describe('backendCollection', () => {
  const collection = backendCollection();

  it('collects under BackendPolicy and launches with ensureOtlpProxy', () => {
    expect(collection.hookPolicy()).toBeInstanceOf(BackendPolicy);
    expect(collection.launcher).toBe(ensureOtlpProxy);
  });

  it('exports the JSON report', () => {
    expect(collection.exportSource()).toBeInstanceOf(ReportSource);
  });

  it('installs no step, no settings field and no summary line', () => {
    expect(collection.install.steps({ webhookUrl: 'https://x', format: 'json', includeExternal: 'never', at: '03:00' })).toEqual([]);
    expect(collection.install.settingsExtras({ node: '/usr/bin/node', entry: '/opt/codemie.js' })).toEqual({});
    expect(collection.install.conclude([])).toEqual({ summary: [] });
  });

  it('tears down by the uninstall removal alone, prints no status line and guards nothing', async () => {
    const removeInstall = vi.fn(async () => undefined);
    await collection.teardown(removeInstall);
    expect(removeInstall).toHaveBeenCalledOnce();
    expect(collection.statusLines()).toEqual([]);
    expect(() => collection.guardProxyCommand('connect')).not.toThrow();
    expect(() => collection.guardProxyCommand('disconnect')).not.toThrow();
  });

  it('starts and restarts the daemon with the proxy commands', () => {
    expect(collection.daemon.start).toBe(startProxy);
    expect(collection.daemon.restart).toBe(restartProxy);
  });

  it('diagnoses with the proxy commands as remedies and every display group', async () => {
    const { doctor } = collection;
    expect(doctor.remedies.connect()).toBe('codemie proxy connect');
    expect(doctor.remedies.connect('--claude-desktop')).toBe('codemie proxy connect --claude-desktop');
    expect(doctor.remedies.disconnect('--vscode-claude-code')).toBe('codemie proxy disconnect --vscode-claude-code');
    expect(doctor.remedies.start).toBe('codemie proxy start');
    expect(doctor.remedies.restart).toBe('codemie proxy restart');
    expect(doctor.groups).toBe(PROXY_DOCTOR_GROUPS);
    await expect(doctor.extraSections()).resolves.toEqual([]);
    expect(doctor.daemonLabel(STATE)).toBe('profile work');
    expect(doctor.nextSteps('stop')).toEqual(['codemie proxy start']);
    expect(doctor.nextSteps('status')).toEqual(['codemie proxy start']);
    expect(doctor.authProbe(true)).toBe(true);
    expect(doctor.authProbe(false)).toBe(false);
    expect(doctor.statusLines(STATE)).toEqual([
      '  Client keys: gk.<client> — written by codemie proxy connect',
      '  Profile: work',
    ]);
    await expect(doctor.deliveryHealth({ json: false })).resolves.toEqual({
      lines: ['Delivery health — run: codemie proxy doctor'],
    });
  });
});
