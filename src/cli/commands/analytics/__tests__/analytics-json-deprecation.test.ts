/**
 * `codemie analytics` names the JSON export deprecated on stderr when the export resolves to json or both, unless the
 * invocation is silent; the deprecation registry holds no entry for it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listDeprecations } from '../../../deprecation.js';
import { createAnalyticsCommand, runAnalytics } from '../index.js';
import type { AnalyticsOptions } from '../types.js';
import type { AnalyticsSource } from '../sources/types.js';

const NOTICE = 'Deprecated: the JSON analytics export (`--export json`).\n';

/** A source with no sessions: the run ends right after the export format is resolved. */
const emptySource = { load: async () => ({ rawSessions: [], cost: null }) } as unknown as AnalyticsSource;

describe('the --export json deprecation notice', () => {
  const originalArgv = process.argv;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.argv = ['node', 'codemie', 'analytics'];
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  const notices = (): string[] => stderr.mock.calls.map((call) => String(call[0])).filter((text) => text.startsWith('Deprecated:'));

  it.each([
    ['--export json', { export: 'json' }],
    ['--export both', { export: 'both' }],
    ['-o report.json', { output: 'report.json' }],
  ] as Array<[string, AnalyticsOptions]>)('%s prints the notice', async (_case, options) => {
    await runAnalytics(options, emptySource);

    expect(notices()).toEqual([NOTICE]);
  });

  it('--export html prints none', async () => {
    await runAnalytics({ export: 'html' }, emptySource);

    expect(notices()).toEqual([]);
  });

  it.each([
    ['a hook', ['node', 'codemie', 'hook', 'analytics']],
    ['the scheduled run', ['node', 'codemie', 'analytics', 'sync', 'run', '--scheduled']],
  ])('in %s prints none', async (_case, argv) => {
    process.argv = argv;

    await runAnalytics({ export: 'json' }, emptySource);

    expect(notices()).toEqual([]);
  });

  it('the deprecation registry holds no entry for --export', () => {
    createAnalyticsCommand();

    expect(listDeprecations().length).toBeGreaterThan(0);
    expect(listDeprecations().filter((entry) => entry.old.includes('--export'))).toEqual([]);
  });
});
