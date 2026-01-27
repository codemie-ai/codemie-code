#!/usr/bin/env node

/**
 * Wrapper script for license-checker that ignores file arguments from lint-staged
 * lint-staged passes matched files as arguments, but license-checker doesn't need them
 */

import { spawnSync } from 'child_process';
import { platform } from 'os';

// Run license-checker without any file arguments
const allowedLicenses = 'MIT;Apache-2.0;ISC;BSD-2-Clause;BSD-3-Clause;0BSD;CC0-1.0;Unlicense;BlueOak-1.0.0;Python-2.0;CC-BY-4.0;Apache*;(MIT OR CC0-1.0);(MIT OR WTFPL);(BSD-2-Clause OR MIT OR Apache-2.0)';

// On Windows, we need shell: true for npx to work
// On Unix/Linux, we should NOT use shell: true to avoid semicolon interpretation
const isWindows = platform() === 'win32';

const result = spawnSync('npx', ['license-checker', '--summary', '--onlyAllow', allowedLicenses], {
  stdio: 'inherit',
  shell: isWindows
});

process.exit(result.status || 0);
