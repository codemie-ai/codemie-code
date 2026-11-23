/**
 * `maskOtlpJson`: OTLP/JSON carries an attribute's name as data (`{ key, value }`), so a secret
 * with no recognisable format must be redacted by that name, on top of the string-level scan.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import {
  maskOtlpJson as maskOtlpJsonWithMode,
  resolveSessionObfuscationMode,
} from '../otlp-json-masking.js';
import { OBFUSCATION_FAILURE_PLACEHOLDER } from '@/utils/analytics-obfuscation.js';

/** The pre-existing secret-masking behaviour: off mode. */
const maskOtlpJson = (parsed: unknown): unknown => maskOtlpJsonWithMode(parsed, 'off');

// A value no embedded-secret pattern recognises: only its attribute name gives it away.
const PLAIN_SECRET = 'correct-horse-battery-staple';
const REDACTED_VALUE = { stringValue: '[REDACTED]' };

type AnyValue = Record<string, unknown>;
interface KeyValue {
  key: string;
  value: AnyValue;
}

const attr = (key: string, value: AnyValue): KeyValue => ({ key, value });
const str = (key: string, stringValue: string): KeyValue => attr(key, { stringValue });

function logsExport(attributes: KeyValue[], resourceAttributes: KeyValue[] = []): unknown {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes },
        scopeLogs: [{ logRecords: [{ body: { stringValue: 'event' }, attributes }] }],
      },
    ],
  };
}

function logAttributes(masked: unknown): KeyValue[] {
  return (masked as { resourceLogs: { scopeLogs: { logRecords: { attributes: KeyValue[] }[] }[] }[] })
    .resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
}

describe('maskOtlpJson — secret-named OTLP attributes', () => {
  it.each(['api_key', 'API-KEY', 'auth_token', 'access_token', 'refresh_token', 'password', 'client_secret', 'cookie', 'Authorization'])(
    'redacts the value of the "%s" attribute even when it matches no secret format',
    (key) => {
      const masked = maskOtlpJson(logsExport([str(key, PLAIN_SECRET)]));

      expect(logAttributes(masked)).toEqual([attr(key, REDACTED_VALUE)]);
      expect(JSON.stringify(masked)).not.toContain(PLAIN_SECRET);
    }
  );

  it('redacts a typed value under a secret-named key, not only strings', () => {
    const masked = maskOtlpJson(
      logsExport([attr('password', { intValue: '123456' }), attr('api_key', { bytesValue: 'c2VjcmV0' })])
    );

    expect(logAttributes(masked)).toEqual([attr('password', REDACTED_VALUE), attr('api_key', REDACTED_VALUE)]);
  });

  it('leaves other attributes untouched, keeping their order and typed values', () => {
    const attributes = [
      str('session.id', 'c73ecba6-c21a-415d-b40f-cb0cdb416155'),
      str('tool_name', 'Read'),
      attr('input_tokens', { intValue: '1200' }),
      attr('success', { boolValue: true }),
      attr('duration_ms', { doubleValue: 12.5 }),
    ];

    expect(logAttributes(maskOtlpJson(logsExport(attributes)))).toEqual(attributes);
  });

  it('redacts only the secret-named attribute among its neighbours', () => {
    const masked = maskOtlpJson(
      logsExport([str('tool_name', 'Bash'), str('api_key', PLAIN_SECRET), str('user.email', 'dev@example.com')])
    );

    expect(logAttributes(masked)).toEqual([
      str('tool_name', 'Bash'),
      attr('api_key', REDACTED_VALUE),
      str('user.email', 'dev@example.com'),
    ]);
  });

  it('covers resource, span, span-event and metric data-point attributes, not only log records', () => {
    const secret = str('auth_token', PLAIN_SECRET);
    const document = {
      resourceLogs: [{ resource: { attributes: [secret] } }],
      resourceSpans: [
        {
          scopeSpans: [{ spans: [{ name: 's', attributes: [secret], events: [{ name: 'e', attributes: [secret] }] }] }],
        },
      ],
      resourceMetrics: [
        { scopeMetrics: [{ metrics: [{ name: 'm', sum: { dataPoints: [{ asInt: '1', attributes: [secret] }] } }] }] },
      ],
    };

    const masked = maskOtlpJson(document) as typeof document;

    const redacted = attr('auth_token', REDACTED_VALUE);
    expect(masked.resourceLogs[0].resource.attributes).toEqual([redacted]);
    expect(masked.resourceSpans[0].scopeSpans[0].spans[0].attributes).toEqual([redacted]);
    expect(masked.resourceSpans[0].scopeSpans[0].spans[0].events[0].attributes).toEqual([redacted]);
    expect(masked.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0].attributes).toEqual([redacted]);
    expect(JSON.stringify(masked)).not.toContain(PLAIN_SECRET);
  });

  it('reaches secret-named entries nested in kvlistValue and arrayValue', () => {
    const nested = attr('config', {
      kvlistValue: { values: [str('mode', 'fast'), str('password', PLAIN_SECRET)] },
    });
    const listed = attr('entries', {
      arrayValue: { values: [{ kvlistValue: { values: [str('client_secret', PLAIN_SECRET)] } }] },
    });

    const masked = logAttributes(maskOtlpJson(logsExport([nested, listed])));

    expect(masked[0]).toEqual(
      attr('config', { kvlistValue: { values: [str('mode', 'fast'), attr('password', REDACTED_VALUE)] } })
    );
    expect(masked[1]).toEqual(
      attr('entries', { arrayValue: { values: [{ kvlistValue: { values: [attr('client_secret', REDACTED_VALUE)] } }] } })
    );
    expect(JSON.stringify(masked)).not.toContain(PLAIN_SECRET);
  });

  it('does not mutate its input', () => {
    const input = logsExport([str('api_key', PLAIN_SECRET)]);
    const snapshot = JSON.stringify(input);

    maskOtlpJson(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('maskOtlpJson — string-level masking still applies', () => {
  const FAKE_SK = 'sk-' + 'A1b2C3d4'.repeat(4);

  it('masks secrets embedded in JSON-encoded attribute strings', () => {
    const toolInput = JSON.stringify({ file_path: '/repo/a.ts', old_string: `new Client("${FAKE_SK}")` });

    const masked = maskOtlpJson(logsExport([str('tool_input', toolInput)]));

    const value = logAttributes(masked)[0].value['stringValue'] as string;
    expect(value).not.toContain(FAKE_SK);
    expect(JSON.parse(value)).toEqual({ file_path: '/repo/a.ts', old_string: 'new Client("[REDACTED]")' });
  });

  it('masks a secret-named attribute and an embedded one in the same record', () => {
    const masked = maskOtlpJson(
      logsExport([str('api_key', PLAIN_SECRET), str('tool_parameters', JSON.stringify({ command: `echo ${FAKE_SK}` }))])
    );

    const serialized = JSON.stringify(masked);
    expect(serialized).not.toContain(PLAIN_SECRET);
    expect(serialized).not.toContain(FAKE_SK);
  });

  it('scans attribute strings over 64 KB in full: masks a secret past the old cap and keeps the tail', () => {
    const filler = 'const answer = compute(42);\n'.repeat(5_000); // ~140 KB
    const newString = `${filler}const client = new Client("${FAKE_SK}");\n${filler}// last line`;
    const toolInput = JSON.stringify({ file_path: '/repo/big.ts', new_string: newString });

    const masked = maskOtlpJson(logsExport([str('tool_input', toolInput)]));

    const value = logAttributes(masked)[0].value['stringValue'] as string;
    expect(value).not.toContain(FAKE_SK);
    expect(value).toContain('const client = new Client(\\"[REDACTED]\\");');
    expect(value.endsWith('// last line"}')).toBe(true);
    expect(value.length).toBeGreaterThan(newString.length - 100);
  });

  it('returns scalars and null unchanged', () => {
    expect(maskOtlpJson(null)).toBeNull();
    expect(maskOtlpJson(42)).toBe(42);
    expect(maskOtlpJson('plain text')).toBe('plain text');
  });
});

describe('maskOtlpJson — robustness', () => {
  it('survives nesting far deeper than any export without overflowing the stack', () => {
    let deep: unknown = str('api_key', PLAIN_SECRET);
    for (let i = 0; i < 5000; i++) {
      deep = { next: deep };
    }

    const masked = maskOtlpJson(deep);

    expect(JSON.stringify(masked)).not.toContain(PLAIN_SECRET);
  });
});


describe('maskOtlpJson — obfuscation on', () => {
  const emailAttr = str('user.prompt', 'mail me at dev@example.com please');

  it('replaces an email in a log attribute when on, and leaves it when off', () => {
    const on = JSON.stringify(maskOtlpJsonWithMode(logsExport([emailAttr]), 'on'));
    expect(on).not.toContain('dev@example.com');
    expect(on).toContain('[REDACTED:EMAIL]');
    expect(JSON.stringify(maskOtlpJsonWithMode(logsExport([emailAttr]), 'off'))).toContain('dev@example.com');
  });

  it('keeps the user.email attribute while a prompt attribute holding an email is still masked', () => {
    const document = {
      resourceLogs: [
        {
          resource: { attributes: [str('user.email', 'dev@example.com')] },
          scopeLogs: [{ logRecords: [{ attributes: [str('user.email', 'dev@example.com'), str('prompt', 'write to dev@example.com or user.email')] }] }],
        },
      ],
    };
    const out = JSON.stringify(maskOtlpJsonWithMode(document, 'on'));
    expect(out.match(/dev@example\.com/g)).toHaveLength(2);
    expect(out).toContain('write to [REDACTED:EMAIL] or user.email');
  });

  it('still masks a secret placed in the user.email attribute', () => {
    const out = JSON.stringify(maskOtlpJsonWithMode(logsExport([str('user.email', 'x Bearer abcdefghijklmnopqrstuvwxyz0123456789')]), 'on'));
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('a field that fails becomes the placeholder while other attributes are still forwarded', () => {
    const huge = str('user.prompt', `dev@example.com ${'x'.repeat(100)}`);
    const masked = maskOtlpJsonWithMode(
      logsExport([huge, str('tool_name', 'Bash'), attr('tokens', { intValue: '42' })]),
      'on',
      { maxInput: 50 }
    );
    expect(logAttributes(masked)).toEqual([
      str('user.prompt', OBFUSCATION_FAILURE_PLACEHOLDER),
      str('tool_name', 'Bash'),
      attr('tokens', { intValue: '42' }),
    ]);
  });
});

describe('resolveSessionObfuscationMode', () => {
  const on = { obfuscation: 'on' as const };
  const off = { obfuscation: 'off' as const };
  /** Settings keyed by cwd; `undefined` is the global layer alone (no project directory). */
  const settingsFor =
    (table: Record<string, typeof on | typeof off>, global: typeof on | typeof off = off) =>
    (cwd: string | undefined) =>
      cwd === undefined ? global : table[cwd] ?? global;
  const cwds = (value: string[]) => async () => value;

  it('a project-only on, resolved from the session directory, gives on before any hook event', async () => {
    const mode = await resolveSessionObfuscationMode('p1', {
      sessionCwds: cwds(['/work/proj']),
      resolveSettings: settingsFor({ '/work/proj': on }),
    });
    expect(mode).toBe('on');
  });

  it('the global layer on gives on', async () => {
    const mode = await resolveSessionObfuscationMode('g1', {
      sessionCwds: cwds(['/work/proj']),
      resolveSettings: settingsFor({}, on),
    });
    expect(mode).toBe('on');
  });

  it('any of the session directories on gives on', async () => {
    const mode = await resolveSessionObfuscationMode('m1', {
      sessionCwds: cwds(['/work/a', '/work/b']),
      resolveSettings: settingsFor({ '/work/b': on }),
    });
    expect(mode).toBe('on');
  });

  it('a mapped directory with nothing on gives off', async () => {
    expect(
      await resolveSessionObfuscationMode('o1', { sessionCwds: cwds(['/work/proj']), resolveSettings: settingsFor({}) })
    ).toBe('off');
  });

  it('no mapping falls back to the global layer: off when it is off, on when it is on', async () => {
    expect(await resolveSessionObfuscationMode('n1', { sessionCwds: cwds([]), resolveSettings: settingsFor({}) })).toBe('off');
    expect(await resolveSessionObfuscationMode('n2', { sessionCwds: cwds([]), resolveSettings: settingsFor({}, on) })).toBe('on');
  });

  it('on stays on for the session once seen', async () => {
    await resolveSessionObfuscationMode('s1', { sessionCwds: cwds(['/work/proj']), resolveSettings: settingsFor({ '/work/proj': on }) });
    expect(
      await resolveSessionObfuscationMode('s1', { sessionCwds: cwds([]), resolveSettings: settingsFor({}) })
    ).toBe('on');
  });

  it('a failing mapping or settings read gives on', async () => {
    expect(
      await resolveSessionObfuscationMode('f1', {
        sessionCwds: async () => {
          throw new Error('boom');
        },
        resolveSettings: settingsFor({}),
      })
    ).toBe('on');
    expect(
      await resolveSessionObfuscationMode('f2', {
        sessionCwds: cwds(['/work/proj']),
        resolveSettings: () => {
          throw new Error('boom');
        },
      })
    ).toBe('on');
  });
});
