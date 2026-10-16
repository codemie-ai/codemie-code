/** The exec environment contract must match Node spawn's unset/override semantics. */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); });

describe('exec child environment', () => {
  it('removes explicitly undefined keys instead of reinheriting the parent value', async () => {
    vi.stubEnv('CODEMIE_TEST_EXEC_DROP', 'parent');
    const { exec } = await import('../exec.js');
    const result = await exec(process.execPath, ['-e', 'process.stdout.write(typeof process.env.CODEMIE_TEST_EXEC_DROP)'], {
      env: { CODEMIE_TEST_EXEC_DROP: undefined }, timeout: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('undefined');
    expect(process.env.CODEMIE_TEST_EXEC_DROP).toBe('parent');
  });

  it('overrides child keys while leaving the parent environment untouched', async () => {
    vi.stubEnv('CODEMIE_TEST_EXEC_VALUE', 'parent');
    const { exec } = await import('../exec.js');
    const result = await exec(process.execPath, ['-e', 'process.stdout.write(process.env.CODEMIE_TEST_EXEC_VALUE)'], {
      env: { CODEMIE_TEST_EXEC_VALUE: 'child' }, timeout: 5000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('child');
    expect(process.env.CODEMIE_TEST_EXEC_VALUE).toBe('parent');
  });
});
