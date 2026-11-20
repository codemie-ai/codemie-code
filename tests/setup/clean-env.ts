/**
 * Unit-test environment isolation.
 *
 * Wrappers such as `codemie-claude` export CODEMIE_* and ANTHROPIC_* variables
 * (proxy URL, profile, credentials, model, session) into the shell that starts
 * Vitest. Left in place, they override test fixtures and fail tests that pass
 * in a plain shell.
 *
 * This setup file runs inside each test worker before its test file, so the
 * deletions affect only that worker's copy of process.env, never the invoking
 * shell. Variables set by the project's own `test.env` (CODEMIE_HOME) are kept.
 */
const PRESERVED = new Set(['CODEMIE_HOME']);
const ISOLATED_PREFIXES = ['CODEMIE_', 'ANTHROPIC_'];

for (const key of Object.keys(process.env)) {
  if (!PRESERVED.has(key) && ISOLATED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    delete process.env[key];
  }
}
