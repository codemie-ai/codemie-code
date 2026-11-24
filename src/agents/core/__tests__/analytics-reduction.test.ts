import { describe, it, expect, vi, beforeEach } from 'vitest';

const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: debugSpy, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { placeholder, reduceBranch, reducePrompt, reduceRecord, type KeepList } from '../analytics-reduction.js';

describe('placeholder', () => {
  it('maps camelCase and snake_case to upper kebab case', () => {
    expect(placeholder('gitBranch')).toBe('REDACTED:GIT-BRANCH');
    expect(placeholder('error_messages')).toBe('REDACTED:ERROR-MESSAGES');
    expect(placeholder('foo_bar')).toBe('REDACTED:FOO-BAR');
  });
});

describe('reduceBranch', () => {
  it('keeps ticket keys as written, de-duplicated, space-joined', () => {
    expect(reduceBranch('feature/EPMCDME-12-secret-client')).toBe('EPMCDME-12');
    expect(reduceBranch('feature/epmcdme-12-x-EPMCDME-12-ABC-3')).toBe('epmcdme-12 ABC-3');
  });
  it('redacts branches without ticket keys', () => {
    expect(reduceBranch('main')).toBe('REDACTED:BRANCH');
  });
  it('passes undefined through', () => {
    expect(reduceBranch(undefined)).toBeUndefined();
  });
});

describe('reduceRecord', () => {
  beforeEach(() => debugSpy.mockClear());
  const keep: KeepList = {
    keep: new Set(['id', 'tool']),
    nested: { meta: { keep: new Set(['ok']) } },
  };

  it('keeps listed keys and numbers/booleans', () => {
    const out = reduceRecord({ id: 'a', tool: 'Bash', n: 3, flag: false }, keep);
    expect(out).toEqual({ id: 'a', tool: 'Bash', n: 3, flag: false });
  });

  it('redacts unlisted future strings, string arrays and objects', () => {
    const out = reduceRecord(
      { id: 'a', foo_bar: 'secret', tags: ['x', 'y'], blob: { a: 1 } },
      keep
    ) as Record<string, unknown>;
    expect(out.foo_bar).toBe('REDACTED:FOO-BAR');
    expect(out.tags).toEqual(['REDACTED:TAGS']);
    expect(out.blob).toBe('REDACTED:BLOB');
  });

  it('recurses into nested entries', () => {
    const out = reduceRecord({ meta: { ok: 'yes', secret: 's' } }, keep) as Record<string, unknown>;
    expect(out.meta).toEqual({ ok: 'yes', secret: 'REDACTED:SECRET' });
  });

  it('passes null and undefined through', () => {
    const out = reduceRecord({ a: null, b: undefined } as Record<string, unknown>, keep);
    expect(out).toEqual({ a: null, b: undefined });
  });

  it('sets a throwing field to REDACTED:FAILED and logs name only', () => {
    const rec: Record<string, unknown> = { id: 'a' };
    Object.defineProperty(rec, 'bad', {
      enumerable: true,
      get() {
        throw new TypeError('SECRET-VALUE');
      },
    });
    const out = reduceRecord(rec, keep) as Record<string, unknown>;
    expect(out.bad).toBe('REDACTED:FAILED');
    expect(out.id).toBe('a');
    const logged = JSON.stringify(debugSpy.mock.calls);
    expect(logged).toContain('bad');
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain('SECRET-VALUE');
  });
});

describe('reducePrompt', () => {
  const CONT = 'This session is being continued from a previous conversation';
  it.each([
    ['/review-pr !456 check auth', {}, '/review-pr !456'],
    ['fix EPMCDME-123 see !456', {}, 'EPMCDME-123 !456'],
    ['epmcdme-123 and EPMCDME-123', {}, 'epmcdme-123'],
    ['hello', {}, 'REDACTED:PROMPT'],
    ['<task-notification><x>secret EPMCDME-1</x>', {}, '<task-notification>'],
    ['<agent-message from=a>hi', {}, '<agent-message'],
    [`${CONT}. Summary: secret EPMCDME-5`, {}, CONT],
    ['run /usr/bin/node', {}, 'REDACTED:PROMPT'],
    ['#fff', {}, 'REDACTED:PROMPT'],
    ['# Plan', {}, 'REDACTED:PROMPT'],
    ['v1.2.3', {}, 'REDACTED:PROMPT'],
    ['https://github.com/o/r/pull/24', {}, '24'],
    ['/clear', {}, '/clear'],
    ['/sdlc-factory:sdlc-standard do it for AB#12', {}, '/sdlc-factory:sdlc-standard AB#12'],
    ['The user asked something', { commandName: 'fleet' }, '/fleet'],
    ['anything', { autoMarker: '<task-notification>' }, '<task-notification>'],
  ])('reduces %j', (raw, opts, expected) => {
    expect(reducePrompt(raw, opts)).toBe(expected);
  });

  it('keeps a ref at the end of a 100 KB prompt, in linear time', () => {
    const raw = `${'lorem ipsum dolor sit amet '.repeat(4000)}EPMCDME-9`;
    const start = performance.now();
    const out = reducePrompt(raw, {});
    expect(performance.now() - start).toBeLessThan(50);
    expect(out).toBe('EPMCDME-9');
  });

  it('bounds the output to 200 characters', () => {
    const raw = `/${'a'.repeat(50)} ${Array.from({ length: 100 }, (_, i) => `PROJ-${i + 1}`).join(' ')}`;
    expect(reducePrompt(raw, {}).length).toBeLessThanOrEqual(200);
  });
});
