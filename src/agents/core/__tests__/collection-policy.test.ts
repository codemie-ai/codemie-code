import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';
import { BackendPolicy } from '../collection-policy.js';

describe('BackendPolicy', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'collection-policy-'));
    vi.stubEnv('CODEMIE_HOME', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('answers the gate it is given', async () => {
    const policy = new BackendPolicy();

    await expect(policy.admit('s1', async () => 'stop')).resolves.toBe('stop');
    await expect(policy.admit(undefined, async () => 'continue')).resolves.toBe('continue');
    await expect(policy.admit('s1', async () => 'retry-after-proxy-start')).resolves.toBe('retry-after-proxy-start');
  });

  it('builds the evidence inputs it is given', async () => {
    await expect(new BackendPolicy().evidenceInputs(async () => ({ routing: 'proven' }))).resolves.toEqual({ routing: 'proven' });
  });

  it('answers the sign-in check it is given, not the allowed value', async () => {
    const denied = { ok: false, reason: 'expired' };
    await expect(new BackendPolicy().authorize(async () => denied, { ok: true })).resolves.toBe(denied);
  });

  it('runs the untracked step for any reason and writes no exclusion mark', async () => {
    const stopMarker = vi.fn(async () => undefined);
    const policy = new BackendPolicy();

    await policy.onUntracked('s1', true, stopMarker);
    await policy.onUntracked('s2', false, stopMarker);

    expect(stopMarker).toHaveBeenCalledTimes(2);
    expect(existsSync(getCodemiePath('analytics', 'excluded'))).toBe(false);
  });

  it('answers the reconnect reason for a corrupt scope file', () => {
    expect(new BackendPolicy().scopeCorruptReason()).toBe('connector scope configuration is corrupt; repair it and reconnect');
  });
});
