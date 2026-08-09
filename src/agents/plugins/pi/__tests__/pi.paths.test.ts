/**
 * Pi session-directory resolution.
 *
 * Focused on the normalization Pi applies to every path it accepts, and on the one value
 * that has no path form at all: a `file://` URL Pi rejects. Two things must hold for it at
 * once, and the last test pins the second one where it actually matters — in the consumer
 * that touches the filesystem, not in the resolver's return shape:
 *
 * - the wrapper must not substitute a directory of its own, because the resolved value is
 *   what Pi is launched with, and a substitute path means the user's transcripts are
 *   written somewhere they will never look for them;
 * - nothing may scan the configured value, because to the filesystem `file://bad` is the
 *   RELATIVE path `<cwd>/file:/bad`, a directory a working tree can happen to contain.
 *
 * @group unit
 */

import { describe, it, expect, afterAll } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { getPiSessionDir, resolvePiSessionDir } from '../pi.paths.js';
import { PiSessionAdapter } from '../pi.session.js';
import { PiPluginMetadata } from '../pi.plugin.js';

const CWD = '/repo';
const MALFORMED_URL = 'file://bad';
const tempDirs: string[] = [];

function makeProjectDir(): string {
  const projectDir = mkdtempSync(join(tmpdir(), 'pi-paths-'));
  tempDirs.push(projectDir);
  return projectDir;
}

function resolveFor(sessionDir: string): string {
  return resolvePiSessionDir(CWD, { PI_CODING_AGENT_SESSION_DIR: sessionDir }).sessionDir;
}

describe('resolvePiSessionDir', () => {
  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('expands a leading tilde the way Pi does', () => {
    expect(resolveFor('~/pi-sessions')).toBe(join(homedir(), 'pi-sessions'));
  });

  it('converts a well-formed file:// URL to a path', () => {
    expect(resolveFor('file:///tmp/pi-sessions')).toBe('/tmp/pi-sessions');
  });

  it('falls back to the default directory for a malformed file:// URL', () => {
    // Not a substitute handed to Pi: `isCustom` is false, so nothing injects
    // PI_CODING_AGENT_SESSION_DIR and Pi still reads the user's own value and aborts on it
    // exactly as a bare `pi` would. What the fallback buys is that the value never reaches
    // the filesystem — see the discovery test below.
    expect(resolvePiSessionDir(CWD, { PI_CODING_AGENT_SESSION_DIR: MALFORMED_URL })).toEqual({
      sessionDir: getPiSessionDir(CWD),
      isCustom: false,
    });
  });

  it('applies the same rule to a sessionDir read from .pi/settings.json', () => {
    const projectDir = makeProjectDir();
    mkdirSync(join(projectDir, '.pi'), { recursive: true });
    writeFileSync(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ sessionDir: MALFORMED_URL }));

    expect(resolvePiSessionDir(projectDir, {})).toEqual({
      sessionDir: getPiSessionDir(projectDir),
      isCustom: false,
    });
  });

  it('reports an explicit directory as custom', () => {
    expect(resolvePiSessionDir(CWD, { PI_CODING_AGENT_SESSION_DIR: '/tmp/x' })).toEqual({
      sessionDir: '/tmp/x',
      isCustom: true,
    });
  });

  it('falls back to the per-cwd encoded default when nothing overrides it', () => {
    const { sessionDir, isCustom } = resolvePiSessionDir(CWD, {});

    expect(isCustom).toBe(false);
    expect(sessionDir).toContain('--repo--');
  });

  it('keeps discovery away from the relative path a malformed file:// URL denotes', async () => {
    const projectDir = makeProjectDir();
    // What `<cwd>/file:/bad` is on disk when the working tree happens to contain it. The
    // transcript declares this project's cwd, so nothing but the session directory itself
    // stands between it and the upload.
    const decoy = join(projectDir, 'file:', 'bad');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(
      join(decoy, 'stranger.jsonl'),
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'stranger',
        timestamp: new Date().toISOString(),
        cwd: projectDir,
      })}\n`
    );

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    try {
      const found = await new PiSessionAdapter(PiPluginMetadata).discoverSessions({
        cwd: projectDir,
        env: { PI_CODING_AGENT_SESSION_DIR: MALFORMED_URL },
      });

      expect(found).toEqual([]);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
