/**
 * CodeMie Home Directory Resolution
 *
 * Respects CODEMIE_HOME environment variable for custom locations.
 * This enables:
 * - Test isolation (each test gets unique temp directory)
 * - Power user customization (relocate data/config)
 * - Multiple instances (development, staging, production)
 *
 * Precedent: CARGO_HOME, POETRY_HOME, NVM_DIR, PYENV_ROOT
 *
 * Default: ~/.codemie
 * Override: CODEMIE_HOME=/custom/path
 */

import { homedir } from 'os';
import { join } from 'path';

/**
 * Get CodeMie home directory
 *
 * Priority:
 * 1. CODEMIE_HOME environment variable
 * 2. ~/.codemie (default)
 *
 * @returns Absolute path to CodeMie home directory
 *
 * @example
 * // Default
 * getCodemieHome() // => '/Users/john/.codemie'
 *
 * // Custom location
 * process.env.CODEMIE_HOME = '/data/codemie';
 * getCodemieHome() // => '/data/codemie'
 *
 * // Test isolation
 * process.env.CODEMIE_HOME = '/tmp/codemie-test-12345';
 * getCodemieHome() // => '/tmp/codemie-test-12345'
 */
export function getCodemieHome(): string {
  if (process.env.CODEMIE_HOME) {
    return process.env.CODEMIE_HOME;
  }

  return join(homedir(), '.codemie');
}

/**
 * Get path within CodeMie home directory
 *
 * @param paths Path segments to join with home directory
 * @returns Absolute path within CodeMie home
 *
 * @example
 * getCodemiePath('logs') // => '/Users/john/.codemie/logs'
 * getCodemiePath('metrics', 'sessions') // => '/Users/john/.codemie/metrics/sessions'
 */
export function getCodemiePath(...paths: string[]): string {
  return join(getCodemieHome(), ...paths);
}
