/**
 * npm legacy prefix override health check
 */

import { getUserNpmPrefix, getLegacyPrefixPath, isSamePath } from '@/utils/npm-prefix.js';
import { HealthCheck, HealthCheckResult, HealthCheckDetail } from '../types.js';

export class NpmPrefixOverrideCheck implements HealthCheck {
  name = 'npm prefix';

  async run(): Promise<HealthCheckResult> {
    const userPrefix = await getUserNpmPrefix();
    const legacyPath = getLegacyPrefixPath();

    if (userPrefix === null || !isSamePath(userPrefix, legacyPath)) {
      return {
        name: this.name,
        success: true,
        details: [{ status: 'ok', message: 'npm prefix is not overridden' }]
      };
    }

    const details: HealthCheckDetail[] = [
      { status: 'warn', message: `User npm prefix is set to CodeMie's legacy path ${legacyPath}` },
      { status: 'info', message: 'npm config delete prefix --location user' },
      { status: 'info', message: `npm ls -g --prefix "${legacyPath}" --depth=0 to see stranded packages` },
      { status: 'info', message: 'reinstall them, for example npm i -g @anthropic-ai/claude-code@latest' },
      { status: 'info', message: 'the old folder can be deleted afterwards' }
    ];

    return { name: this.name, success: true, details };
  }
}
