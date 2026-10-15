/**
 * CodeMie SSO Login Entry Point
 *
 * Spawned as a detached process by the SSO auth gate (see sso.detached-login.ts)
 * so the browser sign-in never blocks the hook that triggered it.
 */
import { parseArgs } from 'node:util';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';
import { releaseLoginLockOnSuccess } from '@/providers/plugins/sso/sso.detached-login.js';
import { logger } from '@/utils/logger.js';

const LOGIN_TIMEOUT_MS = 120_000;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { url: { type: 'string' } } });

  if (!values.url) {
    logger.error('[sso-login] --url is required');
    return 1;
  }

  const result = await new CodeMieSSO().authenticate({
    codeMieUrl: values.url,
    timeout: LOGIN_TIMEOUT_MS,
    quiet: true,
  });

  if (!result.success) {
    logger.error(`[sso-login] Sign-in failed: ${result.error ?? 'unknown error'}`);
  }

  return result.success ? 0 : 1;
}

const exitCode = await main();
if (exitCode === 0) {
  await releaseLoginLockOnSuccess();
}
await logger.close();
process.exit(exitCode);
