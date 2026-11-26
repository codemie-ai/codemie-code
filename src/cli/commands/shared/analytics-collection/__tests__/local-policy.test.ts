import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalPolicy } from '../local-policy.js';
import { markSessionExcluded } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/analytics-exclusion-mark.js';
import { logger } from '@/utils/logger.js';

describe('LocalPolicy', () => {
  let home: string;
  const gate = vi.fn(async (): Promise<'continue' | 'stop'> => 'continue');

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'local-policy-'));
    vi.stubEnv('CODEMIE_HOME', home);
    gate.mockClear();
  });

  afterEach(async () => {
    await logger.close();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  describe('admit', () => {
    it.each([
      ['allowed', true, 'continue'],
      ['not allowed', false, 'stop'],
    ] as const)('%s → %s, the adapter gate never run', async (_case, allowed, expected) => {
      await expect(new LocalPolicy(allowed).admit('sid-1', gate)).resolves.toBe(expected);
      expect(gate).not.toHaveBeenCalled();
    });

    it('an excluded session stops under always', async () => {
      await markSessionExcluded('sid-1');

      await expect(new LocalPolicy(true).admit('sid-1', gate)).resolves.toBe('stop');
      await expect(new LocalPolicy(true).admit('sid-2', gate)).resolves.toBe('continue');
      expect(gate).not.toHaveBeenCalled();
    });
  });

  describe('onUntracked', () => {
    it('with byFilter writes the mark and runs the adapter step', async () => {
      const stopMarker = vi.fn(async () => undefined);

      await new LocalPolicy(true).onUntracked('sid-1', true, stopMarker);

      expect(existsSync(join(home, 'analytics', 'excluded', 'sid-1'))).toBe(true);
      expect(stopMarker).toHaveBeenCalled();
    });

    it('without byFilter writes no mark and runs the adapter step', async () => {
      const stopMarker = vi.fn(async () => undefined);

      await new LocalPolicy(true).onUntracked('sid-1', false, stopMarker);

      expect(existsSync(join(home, 'analytics', 'excluded'))).toBe(false);
      expect(stopMarker).toHaveBeenCalled();
    });

    it('a mark that cannot be written still runs the adapter step, and rejects with the mark\'s error', async () => {
      // A file where the analytics directory goes: the mark's directory cannot be made.
      await writeFile(join(home, 'analytics'), '');
      const stopMarker = vi.fn(async () => undefined);

      await expect(new LocalPolicy(true).onUntracked('sid-1', true, stopMarker)).rejects.toMatchObject({ syscall: 'mkdir' });
      expect(stopMarker).toHaveBeenCalled();
    });

    it('edge: with byFilter and no session id writes no mark', async () => {
      await new LocalPolicy(true).onUntracked(undefined, true, async () => undefined);

      expect(existsSync(join(home, 'analytics', 'excluded'))).toBe(false);
    });
  });

  it('evidenceInputs answers undefined and never builds', async () => {
    const build = vi.fn(async () => ({ routing: 'proven' }));

    await expect(new LocalPolicy(true).evidenceInputs(build)).resolves.toBeUndefined();
    expect(build).not.toHaveBeenCalled();
  });

  it('authorize answers the allowed value and never runs the check', async () => {
    const check = vi.fn(async () => ({ ok: false }));
    const allowed = { ok: true };

    await expect(new LocalPolicy(false).authorize(check, allowed)).resolves.toBe(allowed);
    expect(check).not.toHaveBeenCalled();
  });

  it('scopeCorruptReason names the scope file under CODEMIE_HOME and the install, no reconnect', () => {
    expect(new LocalPolicy(true).scopeCorruptReason()).toBe(
      `connector scope configuration is corrupt; fix or delete ${join(home, 'copilot-connectors.json')} and run \`codemie analytics sync install\``
    );
  });
});
