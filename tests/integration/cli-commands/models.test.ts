import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile } from '../../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';

describe.runIf(INCLUDE_JWT_TESTS)('codemie models list (TC-022)', () => {
  let testHome: string;
  let listResult: ReturnType<typeof spawnSync>;

  beforeAll(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'codemie-models-'));
    const token = await fetchJwtToken();
    writeJwtProfile(testHome, { jwtToken: token });
    listResult = spawnSync(process.execPath, [CLI_BIN, 'models', 'list'], {
      env: { ...process.env, CODEMIE_HOME: testHome, CI: '1' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }, 30_000);

  afterAll(() => rmSync(testHome, { recursive: true, force: true }));

  it('exits 0', () => {
    expect(listResult.status).toBe(0);
  });

  it('output contains the expected model name', () => {
    const out = listResult.stdout + (listResult.stderr ?? '');
    expect(out).toMatch(new RegExp(process.env.CI_CODEMIE_MODEL ?? 'claude', 'i'));
  });
});
