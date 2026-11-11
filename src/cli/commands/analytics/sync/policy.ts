/**
 * Include-external policy for `codemie analytics sync`.
 *
 * `includeExternal` controls whether sync includes data from outside the
 * organization's managed fleet. `'windows'` only includes it on `win32`
 * (CodeMie's managed-device signal), `'always'`/`'never'` ignore the platform.
 */

import type { IncludeExternalPolicy } from './types.js';

export function includeExternalFor(
  policy: IncludeExternalPolicy,
  platform: NodeJS.Platform
): boolean {
  switch (policy) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'windows':
      return platform === 'win32';
  }
}
