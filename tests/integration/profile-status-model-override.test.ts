/**
 * `codemie profile status` through the real CLI: the Model row names the effective model and,
 * when CODEMIE_MODEL replaced the profile's model, the source of the override (shell env or .env).
 *
 * The CLI runs in a child process (runIsolatedCli) against a private CODEMIE_HOME and user home,
 * from a project directory holding a v2 `.codemie/codemie-cli.config.json` with an active litellm
 * profile (no auth validation, so no network or SSO is involved). No CODEMIE_* variable is inherited.
 *
 * Requires dist/ built (bin/codemie.js imports from it). Run:
 *   npx vitest run --project cli tests/integration/profile-status-model-override.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeRun, expectExit, realDir, runIsolatedCli } from '../helpers/isolated-cli.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_READY = existsSync(join(REPO_ROOT, 'dist', 'utils', 'invocation-context.js'))
  && existsSync(join(REPO_ROOT, 'dist', 'utils', 'model-origin.js'));

const PROFILE_NAME = 'litellm-status';
const PROFILE_MODEL = 'profile-model-alpha';
const ENV_MODEL = 'env-model-beta';

/** The value of the `Model` row of the status output, or undefined when no such row is printed. */
function modelRow(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const match = /^\s*Model\s*│\s*(.*?)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

describe.skipIf(!DIST_READY)('codemie profile status - effective model and its source (real CLI)', () => {
  let root: string;
  let homes: { codemieHome: string; userHome: string };
  let projectDir: string;

  beforeEach(() => {
    root = realDir(mkdtempSync(join(tmpdir(), 'codemie-profile-status-')));
    homes = { codemieHome: realDir(join(root, 'codemie-home')), userHome: realDir(join(root, 'home')) };
    projectDir = realDir(join(root, 'project'));
    mkdirSync(join(projectDir, '.codemie'), { recursive: true });
    writeFileSync(
      join(projectDir, '.codemie', 'codemie-cli.config.json'),
      JSON.stringify(
        {
          version: 2,
          activeProfile: PROFILE_NAME,
          profiles: {
            [PROFILE_NAME]: {
              provider: 'litellm',
              baseUrl: 'http://localhost:4000',
              apiKey: 'sk-test-not-a-real-key',
              model: PROFILE_MODEL,
            },
          },
        },
        null,
        2
      ),
      'utf-8'
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const status = (env: Record<string, string> = {}) =>
    runIsolatedCli(homes, ['profile', 'status'], { cwd: projectDir, env });

  // @case profile-status-model-override_TC_007
  it('names the shell env as the source when CODEMIE_MODEL is set in the environment', () => {
    const result = status({ CODEMIE_MODEL: ENV_MODEL });

    expectExit(result, 0);
    expect(modelRow(result.stdout), describeRun(result)).toBe(
      `${ENV_MODEL} (CODEMIE_MODEL from shell env overrides profile: ${PROFILE_MODEL})`
    );
  });

  // @case profile-status-model-override_TC_007
  it('names .env as the source when CODEMIE_MODEL comes only from <cwd>/.env', () => {
    writeFileSync(join(projectDir, '.env'), `CODEMIE_MODEL=${ENV_MODEL}\n`, 'utf-8');

    const result = status();

    expectExit(result, 0);
    expect(modelRow(result.stdout), describeRun(result)).toBe(
      `${ENV_MODEL} (CODEMIE_MODEL from .env overrides profile: ${PROFILE_MODEL})`
    );
  });

  // @case profile-status-model-override_TC_007
  it('shows the profile model with no override marker when CODEMIE_MODEL is absent', () => {
    const result = status();

    expectExit(result, 0);
    expect(modelRow(result.stdout), describeRun(result)).toBe(PROFILE_MODEL);
    expect(result.stdout).not.toContain('overrides');
  });
});
