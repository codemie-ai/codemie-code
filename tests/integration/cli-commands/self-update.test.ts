/**
 * TC-030: codemie self-update --check
 *
 * Verifies the self-update command exits 0 and reports the current version.
 * Uses --check to query the npm registry without triggering an actual install.
 * No auth required: the command only queries the public npm registry.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CODEMIE_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

function getLocalVersion(): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

describe('TC-030 — self-update command', () => {
  it('exits 0 and reports the current version', () => {
    const version = getLocalVersion();

    // Use --check to avoid triggering an actual npm install.
    // FORCE_COLOR=0 strips ANSI codes so plain-text matching works.
    const result = spawnSync(
      process.execPath,
      [CODEMIE_BIN, 'self-update', '--check'],
      {
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );

    // Ora spinner writes to stderr; console.log output goes to stdout.
    const combined = (result.stdout ?? '') + (result.stderr ?? '');

    expect(
      result.status,
      `self-update --check failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    ).toBe(0);

    // Command must produce one of the two expected messages.
    expect(combined, 'expected self-update status output').toMatch(
      /is up to date|Update available/i,
    );

    // When already up to date, the version from package.json must appear.
    // Skipped automatically when npm has a newer release (Update available path).
    if (/is up to date/i.test(combined) && version) {
      expect(combined, `expected version ${version} in "up to date" message`).toContain(version);
    }
  });
});
