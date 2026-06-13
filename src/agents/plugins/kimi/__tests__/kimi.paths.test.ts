import { createHash } from 'crypto';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.KIMI_CODE_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = originalHome;
    }
  });

  it('returns default home when KIMI_CODE_HOME is not set', () => {
    delete process.env.KIMI_CODE_HOME;

    const home = getKimiCodeHome();

    expect(home).toMatch(/.kimi-code$/);
  });

  it('respects KIMI_CODE_HOME', () => {
    process.env.KIMI_CODE_HOME = '/custom/kimi/home';

    expect(getKimiCodeHome()).toBe('/custom/kimi/home');
    expect(getKimiConfigPath()).toBe('/custom/kimi/home/config.toml');
    expect(getKimiSessionsDir()).toBe('/custom/kimi/home/sessions');
    expect(getKimiUserSkillsDir()).toBe('/custom/kimi/home/skills');
  });

  it('computes session directory from cwd and session id', () => {
    const cwd = '/Users/alice/projects/my-app';
    const sessionId = 'session-123';
    const workDirKey = encodeKimiWorkDirKey(cwd);
    const sessionDir = getKimiSessionDir(cwd, sessionId);

    expect(sessionDir).toBe(path.join(getKimiSessionsDir(), workDirKey, sessionId));
  });

  it('returns main wire path', () => {
    const cwd = '/Users/alice/projects/my-app';
    const sessionId = 'session-123';
    const sessionDir = getKimiSessionDir(cwd, sessionId);
    const wirePath = getKimiMainWirePath(cwd, sessionId);

    expect(wirePath).toBe(path.join(sessionDir, 'agents', 'main', 'wire.jsonl'));
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

  describe('encodeKimiWorkDirKey edge cases', () => {
    it('handles root-like paths', () => {
      const key = encodeKimiWorkDirKey('/');

      expect(key).toMatch(/^wd_workspace_[0-9a-f]{12}$/);
    });

    it('handles cwd ending in .', () => {
      const key = encodeKimiWorkDirKey('/path/to/.');
      const resolved = path.resolve('/path/to/.');

      expect(key).toBe(`wd_to_${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`);
    });

    it('handles cwd ending in ..', () => {
      const key = encodeKimiWorkDirKey('/path/to/..');
      const resolved = path.resolve('/path/to/..');

      expect(key).toBe(`wd_path_${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`);
    });

    it('replaces cwd with only special characters to workspace', () => {
      const key = encodeKimiWorkDirKey('/path/!@#$%');
      const resolved = path.resolve('/path/!@#$%');

      expect(key).toMatch(/^wd_workspace_[0-9a-f]{12}$/);
      expect(key).toBe(`wd_workspace_${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`);
    });

    it('truncates very long directory names to 40 characters', () => {
      const longName = 'a'.repeat(100);
      const cwd = `/path/${longName}`;
      const resolved = path.resolve(cwd);
      const key = encodeKimiWorkDirKey(cwd);
      const expectedSlug = 'a'.repeat(40);
      const expectedHash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);

      expect(key).toBe(`wd_${expectedSlug}_${expectedHash}`);
    });

    it('sanitizes non-ascii and whitespace characters', () => {
      const cwd = '/path/My Project 日本語';
      const resolved = path.resolve(cwd);
      const key = encodeKimiWorkDirKey(cwd);
      const expectedHash = createHash('sha256').update(resolved).digest('hex').slice(0, 12);

      expect(key).toBe(`wd_my-project_${expectedHash}`);
    });

    it('produces deterministic hash for the same resolved path', () => {
      const cwd = '/Users/alice/projects/my-app';

      const first = encodeKimiWorkDirKey(cwd);
      const second = encodeKimiWorkDirKey(cwd);

      expect(first).toBe(second);
    });

    it('produces different hashes for different paths with the same basename', () => {
      const keyA = encodeKimiWorkDirKey('/Users/alice/my-app');
      const keyB = encodeKimiWorkDirKey('/Users/bob/my-app');

      expect(keyA).not.toBe(keyB);
    });
  });
});
