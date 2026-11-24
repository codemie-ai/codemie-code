/**
 * `maskSecretsInLongText`: full-length masking in safely split chunks, used for OTLP/JSON telemetry
 * where nothing downstream cuts strings to a fixed length.
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { maskSecretsInLongText } from '../long-text-masking.js';
import { maskSecretsInText, maskSecretsDeep } from '../security.js';

describe('maskSecretsInLongText', () => {
  const R = '[REDACTED]';
  const KEY = 'sk-' + 'A1b2C3d4'.repeat(4); // gitleaks:allow
  const CAP = 64 * 1024;
  // Built from parts so no private-key-shaped literal sits in the source.
  const PEM_BEGIN = '-----BEGIN ' + 'PRIVATE KEY-----';
  const PEM_END = '-----END ' + 'PRIVATE KEY-----';
  const prose = (chars: number): string => 'lorem ipsum dolor sit amet\n'.repeat(Math.ceil(chars / 27)).slice(0, chars);

  it('gives the same result as maskSecretsInText for text within 64 KB', () => {
    const text = `before ${KEY} after PASSWORD=hunter2xyz end`; // gitleaks:allow
    expect(maskSecretsInLongText(text)).toBe(maskSecretsInText(text));
    expect(maskSecretsInLongText('')).toBe('');
  });

  it('keeps the tail that maskSecretsInText drops, and masks a secret placed beyond 64 KB', () => {
    const text = `${prose(200_000)} api key ${KEY} the-very-end`;

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain(KEY);
    expect(masked).toContain(`api key ${R} the-very-end`);
    expect(maskSecretsInText(text)).toHaveLength(CAP);
  });

  it('returns secret-free text of any length unchanged', () => {
    const text = prose(500_000);
    expect(maskSecretsInLongText(text)).toBe(text);
  });

  it('masks a secret that straddles a chunk boundary, with whitespace around it', () => {
    const secret = 'Authorization: Bearer ' + 'abcd1234'.repeat(5);
    const text = ' '.repeat(CAP - 12) + secret + ' trailing ' + prose(CAP);

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain('abcd1234');
    expect(masked).toContain(`Authorization: ${R}\n`); // the pattern takes the rest of the line
    expect(masked.startsWith(' '.repeat(1000))).toBe(true);
    expect(masked).toContain('lorem ipsum dolor sit amet'); // text after the secret's line survives
  });

  it('masks a secret that straddles a chunk boundary with no whitespace to split on', () => {
    const text = '-'.repeat(CAP - 15) + KEY + ' end' + '-'.repeat(CAP);

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain('A1b2C3d4');
    expect(masked).toContain(`${R} end`);
    expect(masked.endsWith('-'.repeat(1000))).toBe(true);
  });

  it('masks a PEM block that straddles a chunk boundary and keeps the text after it', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n'.repeat(60);
    const pem = `${PEM_BEGIN}\n${body}${PEM_END}`;
    const text = prose(CAP - 900) + '\n' + pem + '\n' + prose(CAP) + ' THE-END';

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain('MIIEvQIBADANBg');
    expect(masked).toContain(`${R}\nlorem ipsum`);
    expect(masked.endsWith(' THE-END')).toBe(true);
  });

  it('masks a PEM block larger than the boundary check window, keeping the text after its END line', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n'.repeat(3_000); // ~100 KB, spans two chunk boundaries
    const pem = `${PEM_BEGIN}\n${body}${PEM_END}`;
    const text = prose(CAP - 5_000) + '\n' + pem + '\nafter-the-key ' + prose(CAP) + ' THE-END';

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain('MIIEvQ');
    expect(masked).toContain(`${R}\nafter-the-key lorem ipsum`);
    expect(masked.endsWith(' THE-END')).toBe(true);
  });

  it('redacts an unterminated PEM block through the end of the text, as the short-text masker does', () => {
    const text = `before\n${PEM_BEGIN}\n` + 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n'.repeat(10_000);

    const masked = maskSecretsInLongText(text);

    expect(masked).toBe(`before\n${R}`);
  });

  it('fails closed when no safe boundary exists: the rest is redacted, never returned unscanned', () => {
    // One unbroken name=value match covers every possible boundary.
    const text = 'password='.repeat(60_000);

    const masked = maskSecretsInLongText(text);

    expect(masked).toBe(R);
  });

  it('replaces text beyond 8 MB with a truncation marker instead of scanning it', () => {
    const ceiling = 8 * 1024 * 1024;
    const text = prose(ceiling) + 'x'.repeat(1234);

    const started = Date.now();
    const masked = maskSecretsInLongText(text);

    // The cut is a safe boundary at or just before 8 MB, so the marker counts everything after it.
    const marker = /\[TRUNCATED: (\d+) chars omitted\]$/.exec(masked);
    expect(marker).not.toBeNull();
    const omitted = Number(marker?.[1]);
    expect(omitted).toBeGreaterThanOrEqual(1234);
    expect(omitted).toBeLessThan(1234 + 4096 + 256);
    expect(masked.length - (marker?.[0].length ?? 0)).toBe(text.length - omitted); // secret-free prose is kept as is
    expect(masked.startsWith(text.slice(0, 1000))).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('places the 8 MB cut on a safe boundary, so a secret straddling it leaves no fragment', () => {
    const ceiling = 8 * 1024 * 1024;
    // The key starts 15 characters before the cut: a leading 15-character fragment would match no pattern.
    const text = '.'.repeat(ceiling - 15) + KEY + ' end' + '.'.repeat(1000);

    const masked = maskSecretsInLongText(text);

    expect(masked).not.toContain('sk-');
    expect(masked).not.toContain('A1b2C3d4');
    expect(masked).toMatch(/\[TRUNCATED: \d+ chars omitted\]$/);
  });

  it('omits the last chunk when no boundary near the 8 MB cut is safe', () => {
    const ceiling = 8 * 1024 * 1024;
    // 100 characters of key straddle the cut, with no whitespace to split on and every nearby boundary inside it.
    const text = '.'.repeat(ceiling - 40) + 'sk-' + 'A'.repeat(100) + ' end';

    const masked = maskSecretsInLongText(text);

    const lastChunkStart = 127 * 64 * 1024; // 127 full chunks, then the final 64 KB chunk that holds the key
    expect(masked).not.toContain('sk-');
    expect(masked).not.toContain('AAAA');
    expect(masked).toBe('.'.repeat(lastChunkStart) + `[TRUNCATED: ${text.length - lastChunkStart} chars omitted]`);
  });

  it('returns quickly for pathological inputs over 64 KB', () => {
    const inputs = [
      'x'.repeat(400_000),
      'a-'.repeat(200_000),
      'postgres://a:'.repeat(40_000),
      '-----BEGIN PRIVATE KEY-----'.repeat(10_000),
      'Bearer '.repeat(60_000),
      'password='.repeat(60_000),
      '--token '.repeat(20_000),
      'curl -u '.repeat(20_000),
      'mysql -h '.repeat(20_000),
    ];
    const started = Date.now();
    for (const input of inputs) {
      maskSecretsInLongText(input);
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('is used by maskSecretsDeep when passed as the text masker', () => {
    const text = `${prose(100_000)} ${KEY}`;

    const withDefault = maskSecretsDeep({ a: text }) as { a: string };
    const withLong = maskSecretsDeep({ a: text }, undefined, maskSecretsInLongText) as { a: string };

    expect(withDefault.a).toHaveLength(CAP);
    expect(withLong.a).not.toContain(KEY);
    expect(withLong.a.length).toBeGreaterThan(100_000);
  });
});
