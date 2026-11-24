/**
 * Live CodeMie model catalog access for the agent analytics integration tests.
 */

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { LlmModel } from '../../src/providers/plugins/sso/sso.http-client.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Fetch the live model catalog in a throwaway CHILD process, not in-process.
 *
 * The `agent` vitest project pins `CODEMIE_HOME` to a fixed per-worker temp dir (see
 * vitest.config.ts) for every test file in it. `CredentialStore`'s `CREDENTIALS_DIR` (in
 * src/utils/security.ts) is computed once, at module-load time, from that same env var — so
 * importing `CodeMieSSO`/`CredentialStore` in-process would look for credentials under the
 * project's fake test home, not the real `~/.codemie`. Spawning a bare node process with
 * `CODEMIE_*` stripped gives that process a fresh, correct module load against the real home
 * instead.
 *
 * `scriptName` names the generated temp script (`codemie-<scriptName>-<pid>.mjs`) so concurrent
 * test files never write to the same path.
 */
export function fetchLiveCatalog(codeMieUrl: string, scriptName: string): LlmModel[] {
  // ESM imports need file:// URLs: a raw `C:\...` path is read as a `c:` scheme on Windows.
  const distSsoAuth = pathToFileURL(join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.auth.js')).href;
  const distHttpClient = pathToFileURL(join(REPO_ROOT, 'dist', 'providers', 'plugins', 'sso', 'sso.http-client.js')).href;
  const scriptPath = join(tmpdir(), `codemie-${scriptName}-${process.pid}.mjs`);
  const script = `
import { CodeMieSSO } from ${JSON.stringify(distSsoAuth)};
import { fetchCodeMieLlmModels } from ${JSON.stringify(distHttpClient)};
const url = ${JSON.stringify(codeMieUrl)};
const creds = await new CodeMieSSO().getStoredCredentials(url);
if (!creds) {
  console.error('NO_CREDENTIALS');
  process.exit(2);
}
const models = await fetchCodeMieLlmModels(creds.apiUrl, creds.cookies);
process.stdout.write(JSON.stringify(models));
`;
  writeFileSync(scriptPath, script, 'utf-8');
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('CODEMIE_')) delete env[key];
    }
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf-8', env, timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(
        `catalog fetch failed (exit ${result.status ?? 'null'}): ${result.stderr}\n` +
          `Run: codemie profile login --url ${codeMieUrl}`,
      );
    }
    return JSON.parse(result.stdout) as LlmModel[];
  } finally {
    rmSync(scriptPath, { force: true });
  }
}
