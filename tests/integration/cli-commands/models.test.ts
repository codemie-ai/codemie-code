import '../../setup/load-test-env.js';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchJwtToken,
  writeJwtProfile,
  writeSsoProfile,
  copySsoCredentials,
  getTempDir,
  jwtCleanEnv,
  ssoCleanEnv,
  setupSsoAutotestProfile,
  teardownSsoAutotestProfile,
  getTestEnvFlagOrDefault,
} from '../../helpers/index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_BIN = join(REPO_ROOT, 'bin', 'codemie.js');

const CI_IS_LOCAL_RUN = getTestEnvFlagOrDefault('CI_IS_LOCAL_RUN', true);

describe('codemie models list (TC-022)', () => {
  let jwtToken: string;
  let testHome: string;
  let listResult: ReturnType<typeof spawnSync>;
  let originalActiveProfile: string | undefined;

  beforeAll(async () => {
    testHome = mkdtempSync(join(getTempDir(), 'codemie-models-'));

    if (!CI_IS_LOCAL_RUN) {
      jwtToken = await fetchJwtToken();
      writeJwtProfile(testHome, { jwtToken });
    } else {
      originalActiveProfile = setupSsoAutotestProfile();
      writeSsoProfile(testHome);
      copySsoCredentials(testHome);
    }

    listResult = spawnSync(
      process.execPath,
      [CLI_BIN, 'models', 'list'],
      {
        cwd: testHome,
        env: {
          ...(CI_IS_LOCAL_RUN ? ssoCleanEnv() : jwtCleanEnv()),
          CODEMIE_HOME: testHome,
          ...(CI_IS_LOCAL_RUN ? {} : { CODEMIE_JWT_TOKEN: jwtToken }),
          CI: '1',
        },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
  }, 60_000);

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
    if (CI_IS_LOCAL_RUN) {
      teardownSsoAutotestProfile(originalActiveProfile);
    }
  });

  it('exits 0', () => {
    expect(listResult.status, `stdout: ${listResult.stdout ?? ''}\nstderr: ${listResult.stderr ?? ''}`).toBe(0);
  });

  it('output contains the expected model name', () => {
    const out = listResult.stdout + (listResult.stderr ?? '');
    expect(out).toMatch(new RegExp(process.env.CI_CODEMIE_MODEL ?? 'claude', 'i'));
  });
});
