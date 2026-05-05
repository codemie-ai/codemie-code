/**
 * Hard auth gate for `codemie skills *` subcommands.
 *
 * Per spec §7, every subcommand must verify CodeMie SSO credentials before
 * any side effect (skills.sh spawn, metrics emission, etc.). On failure the
 * wrapper prints the canonical SSO message to stderr and exits with code 1.
 * No metric is emitted because the metrics transport itself depends on the
 * authenticated context that is missing.
 */

import chalk from 'chalk';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';

const NOT_AUTHENTICATED_MESSAGE =
  'CodeMie SSO authentication required. Run "codemie setup" or "codemie profile login" first.';

/**
 * Verify SSO credentials are present.
 *
 * @returns true on success. On failure, logs the canonical message and
 *          calls `process.exit(1)` (does not return).
 */
export async function requireAuthenticatedSession(): Promise<boolean> {
  try {
    const config = await ConfigLoader.load();
    const lookupUrl = config.codeMieUrl || config.baseUrl;
    if (!lookupUrl) {
      failAuth('No CodeMie URL configured. Run "codemie setup" first.');
    }

    const { CodeMieSSO } = await import('@/providers/plugins/sso/sso.auth.js');
    const sso = new CodeMieSSO();
    const credentials = await sso.getStoredCredentials(lookupUrl);

    if (!credentials?.cookies || Object.keys(credentials.cookies).length === 0) {
      failAuth(NOT_AUTHENTICATED_MESSAGE);
    }

    return true;
  } catch (error) {
    logger.debug('[skills] Auth check threw; treating as unauthenticated', error);
    failAuth(NOT_AUTHENTICATED_MESSAGE);
  }
}

function failAuth(message: string): never {
  console.error(chalk.red(`\n${message}\n`));
  process.exit(1);
}
