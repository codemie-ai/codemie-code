/**
 * Legacy CodeMie npm prefix override health check
 */

import { getCodemieNpmPrefix, getUserNpmrcPrefix, getLegacyNpmPrefixPath } from '@/utils/npm-prefix.js';
import { isSamePath } from '@/utils/paths.js';
import { HealthCheck, HealthCheckDetail, HealthCheckResult } from '../types.js';

export class NpmPrefixOverrideCheck implements HealthCheck {
  name = 'npm prefix';

  async run(): Promise<HealthCheckResult> {
    const userPrefix = await getUserNpmrcPrefix();
    const legacyPath = getLegacyNpmPrefixPath();

    if (userPrefix === null || !isSamePath(userPrefix, legacyPath)) {
      return {
        name: this.name,
        success: true,
        details: [{ status: 'ok', message: 'User .npmrc does not override the global npm prefix' }]
      };
    }

    const codemiePrefix = getCodemieNpmPrefix();
    const runsFromLegacyPath = codemiePrefix !== null && isSamePath(codemiePrefix, legacyPath);

    const details: HealthCheckDetail[] = [
      {
        status: 'warn',
        message: `User .npmrc redirects every global npm install to ${legacyPath}`,
        hint: 'Rerun the CodeMie installer, or fix it manually with the steps below'
      },
      { status: 'info', message: `1. List affected packages: npm ls -g --prefix "${legacyPath}" --depth=0` },
      { status: 'info', message: '2. Remove the override: npm config delete prefix --location user' }
    ];
    if (runsFromLegacyPath) {
      details.push({
        status: 'info',
        message:
          '3. Reinstall your own listed tools, e.g. npm i -g @anthropic-ai/claude-code@latest; ' +
          'leave @codemieai/code and agents installed by CodeMie where they are'
      });
    } else {
      details.push(
        { status: 'info', message: '3. Reinstall each listed package, e.g. npm i -g @anthropic-ai/claude-code@latest' },
        { status: 'info', message: `4. Optionally delete ${legacyPath}` }
      );
    }

    return { name: this.name, success: false, details };
  }
}
