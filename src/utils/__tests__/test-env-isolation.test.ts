/**
 * Guards tests/setup/clean-env.ts: the unit project must not see CODEMIE_* / ANTHROPIC_*
 * variables inherited from the shell, but must keep the CODEMIE_HOME the config sets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';

const SET_BY_TEST = [
  'CODEMIE_FOO', 'ANTHROPIC_BAR', 'codemie_lower',
  'CLAUDE_CODE_FOO', 'OPENAI_API_KEY', 'AWS_PROFILE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
];

describe('unit test environment isolation', () => {
  let home: string | undefined;

  beforeEach(() => {
    home = process.env.CODEMIE_HOME;
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of SET_BY_TEST) delete process.env[key];
    if (home === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = home;
  });

  it('removes inherited wrapper variables, whatever their case', async () => {
    for (const key of SET_BY_TEST) process.env[key] = '1';

    await import('../../../tests/setup/clean-env.js');

    for (const key of SET_BY_TEST) expect(process.env[key]).toBeUndefined();
  });

  it('keeps every variable the config lists in VITEST_PRESERVE_ENV', async () => {
    const kept = (process.env.VITEST_PRESERVE_ENV ?? '').split(',').filter(Boolean);
    expect(kept).toContain('CODEMIE_HOME');
    const before = Object.fromEntries(kept.map((key) => [key, process.env[key]]));

    await import('../../../tests/setup/clean-env.js');

    for (const key of kept) expect(process.env[key]).toBe(before[key]);
  });

  it('keeps CODEMIE_HOME pointing at the temp directory the config sets', async () => {
    expect(process.env.CODEMIE_HOME).toBeDefined();
    expect(process.env.CODEMIE_HOME!.startsWith(tmpdir())).toBe(true);

    await import('../../../tests/setup/clean-env.js');

    expect(process.env.CODEMIE_HOME!.startsWith(tmpdir())).toBe(true);
  });
});
