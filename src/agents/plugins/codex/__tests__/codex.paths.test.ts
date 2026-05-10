import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

import { getCodexHomePath, getCodexSessionDayPath } from '../codex.paths.js';

describe('Codex path resolution', () => {
  const originalCodexHome = process.env.CODEX_HOME;

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it('uses CODEX_HOME when Codex is launched with an isolated state directory', () => {
    process.env.CODEX_HOME = '/tmp/codemie-codex-home';

    expect(getCodexHomePath()).toBe('/tmp/codemie-codex-home');
    expect(getCodexSessionDayPath(new Date('2026-05-09T12:00:00Z'))).toBe(
      join('/tmp/codemie-codex-home', 'sessions', '2026', '05', '09')
    );
  });

  it('falls back to the native Codex home when CODEX_HOME is not set', () => {
    delete process.env.CODEX_HOME;

    expect(getCodexHomePath()).toBe(join(homedir(), '.codex'));
  });
});
