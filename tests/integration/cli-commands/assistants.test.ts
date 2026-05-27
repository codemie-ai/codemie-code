import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fetchJwtToken, writeJwtProfile } from '../../helpers/index.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');
const INCLUDE_JWT_TESTS = process.env.INCLUDE_JWT_TESTS === 'true';


describe.runIf(INCLUDE_JWT_TESTS)('Assistants — list (TC-014)', () => {
  let testHome: string;   // CODEMIE_HOME
  let fakeHome: string;   // fake os.homedir() for .claude/agents/ lookup
  let listResult: SpawnSyncReturns<string>;

  beforeAll(async () => {
    if (!process.env.CI_CODEMIE_ASSISTANT_ID) {
      throw new Error('CI_CODEMIE_ASSISTANT_ID must be set when INCLUDE_JWT_TESTS=true');
    }
    fakeHome = mkdtempSync(join(tmpdir(), 'codemie-asst-home-'));
    testHome = join(fakeHome, '.codemie');

    const jwtToken = await fetchJwtToken();
    writeJwtProfile(testHome, { jwtToken });

    listResult = spawnSync(process.execPath, [CLI_BIN, 'assistants', 'list'], {
      env: { ...process.env, CODEMIE_HOME: testHome, CI: '1', NODE_ENV: 'test' },
      encoding: 'utf-8',
      timeout: 30_000,
    });
  }, 30_000);

  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

  it('assistants list exits 0 and shows known assistant', () => {
    const out = listResult.stdout + (listResult.stderr ?? '');
    expect(listResult.status).toBe(0);
    expect(out).toMatch(new RegExp(process.env.CI_CODEMIE_ASSISTANT_ID ?? '', 'i'));
  });
});

describe.runIf(INCLUDE_JWT_TESTS)('Assistants chat — invalid ID (TC-015)', () => {
  let testHome: string;
  let fakeHome: string;

  beforeAll(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'codemie-asst-invalid-'));
    testHome = join(fakeHome, '.codemie');
    const token = await fetchJwtToken();
    writeJwtProfile(testHome, { jwtToken: token });
  }, 30_000);

  afterAll(() => rmSync(fakeHome, { recursive: true, force: true }));

  it('exits non-zero and shows error for invalid assistant', () => {
    const r = spawnSync(
      process.execPath,
      [CLI_BIN, 'assistants', 'chat', 'nonexistent-assistant-id-xyz', 'hello'],
      {
        env: { ...process.env, CODEMIE_HOME: testHome, CI: '1', NODE_ENV: 'test' },
        encoding: 'utf-8',
        timeout: 30_000,
      }
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout + (r.stderr ?? '')).toMatch(/not found|invalid|error|failed|unknown/i);
  });
});
