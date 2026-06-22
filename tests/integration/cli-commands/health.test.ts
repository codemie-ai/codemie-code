/**
 * Agent health check — TC-031
 *
 * Run with: npm run test:integration
 *
 * No auth is required — the health subcommand only checks whether the agent
 * binary is installed on the system; it does not contact any CodeMie server.
 */

import '../../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTempDir, jwtCleanEnv } from '../../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLAUDE_BIN = join(REPO_ROOT, 'bin', 'codemie-claude.js');

describe('codemie-claude health (TC-031)', () => {
  let testHome: string;
  let result: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    testHome = mkdtempSync(join(getTempDir(), 'codemie-health-'));
    result = spawnSync(
      process.execPath,
      [CLAUDE_BIN, 'health'],
      {
        env: { ...jwtCleanEnv(), CODEMIE_HOME: testHome },
        encoding: 'utf-8',
        timeout: 15_000,
      },
    );
  }, 30_000);

  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits 0', () => {
    expect(result.status, `stdout: ${result.stdout ?? ''}\nstderr: ${result.stderr ?? ''}`).toBe(0);
  });

  it('output mentions install, binary, or health', () => {
    expect((result.stdout ?? '') + (result.stderr ?? '')).toMatch(/install|binary|health/i);
  });
});
