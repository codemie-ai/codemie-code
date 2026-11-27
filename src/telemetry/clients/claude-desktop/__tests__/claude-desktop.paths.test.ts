/**
 * @group unit
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { getClaudeDesktopAppCandidates } from '../claude-desktop.paths.js';

const originalPlatform = process.platform;
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('getClaudeDesktopAppCandidates', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
    vi.unstubAllEnvs();
  });

  it('lists the system and the user Applications folders on darwin, in that order', () => {
    vi.stubEnv('HOME', '/tmp/desktop-home');
    vi.stubEnv('USERPROFILE', '/tmp/desktop-home');
    setPlatform('darwin');
    expect(getClaudeDesktopAppCandidates()).toEqual([
      '/Applications/Claude.app',
      join('/tmp/desktop-home', 'Applications', 'Claude.app'),
    ]);
  });

  it.each(['win32', 'linux'] as const)('lists nothing on %s', (platform) => {
    setPlatform(platform);
    expect(getClaudeDesktopAppCandidates()).toEqual([]);
  });
});
