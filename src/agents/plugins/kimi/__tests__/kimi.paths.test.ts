import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import path from 'path';
import {
  encodeKimiWorkDirKey,
  getKimiCodeHome,
  getKimiConfigPath,
  getKimiMainWirePath,
  getKimiSessionDir,
  getKimiSessionsDir,
  getKimiUserSkillsDir,
} from '../kimi.paths.js';

describe('kimi paths', () => {
  it('returns default home from env', () => {
    const home = getKimiCodeHome();

    expect(home).toMatch(/.kimi-code$/);
  });

  it('respects KIMI_CODE_HOME', () => {
    const originalHome = process.env.KIMI_CODE_HOME;
    process.env.KIMI_CODE_HOME = '/custom/kimi/home';

    try {
      expect(getKimiCodeHome()).toBe('/custom/kimi/home');
      expect(getKimiConfigPath()).toBe('/custom/kimi/home/config.toml');
      expect(getKimiSessionsDir()).toBe('/custom/kimi/home/sessions');
      expect(getKimiUserSkillsDir()).toBe('/custom/kimi/home/skills');
    } finally {
      if (originalHome === undefined) {
        delete process.env.KIMI_CODE_HOME;
      } else {
        process.env.KIMI_CODE_HOME = originalHome;
      }
    }
  });

  it('computes session directory from cwd and session id', () => {
    const cwd = '/Users/alice/projects/my-app';
    const sessionId = 'session-123';
    const sessionDir = getKimiSessionDir(cwd, sessionId);

    expect(sessionDir).toContain(sessionId);
    expect(sessionDir).toContain(encodeKimiWorkDirKey(cwd));
  });

  it('returns main wire path', () => {
    const cwd = '/Users/alice/projects/my-app';
    const sessionId = 'session-123';
    const wirePath = getKimiMainWirePath(cwd, sessionId);

    expect(wirePath).toMatch(/agents[/\\]main[/\\]wire\.jsonl$/);
  });

  it('encodes work dir key like Kimi CLI', () => {
    const cwd = '/Users/alice/projects/My Project-1';
    const resolvedCwd = path.resolve(cwd);
    const key = encodeKimiWorkDirKey(cwd);

    expect(key).toMatch(/^wd_[a-z0-9._-]+_[0-9a-f]{12}$/);

    const expectedHash = createHash('sha256')
      .update(resolvedCwd)
      .digest('hex')
      .slice(0, 12);

    expect(key.endsWith(`_${expectedHash}`)).toBe(true);
  });
});
