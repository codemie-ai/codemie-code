/**
 * encodeClaudeProjectDir mirrors Claude Code's projects/<encoded-cwd> directory naming.
 * @group unit
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const { encodeClaudeProjectDir, decodeClaudeProjectDir } = await import('../claude.session.js');

describe('encodeClaudeProjectDir', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    expect(encodeClaudeProjectDir('/Users/jane_doe/dev/my-repo')).toBe('-Users-jane-doe-dev-my-repo');
  });

  it('encodes from the realpath when the cwd is reached through a symlink', () => {
    const base = mkdtempSync(join(tmpdir(), 'enc.proj-'));
    try {
      const real = join(base, 'real.dir');
      mkdirSync(real);
      const link = join(base, 'link');
      symlinkSync(real, link);
      const expected = realpathSync(real).replace(/[^a-zA-Z0-9]/g, '-');
      expect(encodeClaudeProjectDir(link)).toBe(expected);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to the input when the path does not exist', () => {
    expect(encodeClaudeProjectDir('/no/such.dir/x')).toBe('-no-such-dir-x');
  });

  it('round-trips a simple path through the decoder', () => {
    expect(decodeClaudeProjectDir(encodeClaudeProjectDir('/nonexistentabc/dev/repo'))).toBe('/nonexistentabc/dev/repo');
  });
});
