/**
 * Test environment isolation.
 *
 * Wrappers such as `codemie-claude` export CODEMIE_* and ANTHROPIC_* variables
 * (proxy URL, profile, credentials, model, session) into the shell that starts
 * Vitest. Left in place, they override test fixtures and fail tests that pass
 * in a plain shell. The same holds for the other wrapper-style variables listed below.
 *
 * This setup file runs inside each test worker before its test file, so the
 * deletions affect only that worker's copy of process.env, never the invoking
 * shell. Variables set by the project's `test.env` (see vitest.config.ts) are kept:
 * the config lists their names in VITEST_PRESERVE_ENV.
 */
const ISOLATED_PREFIXES = ['CODEMIE_', 'ANTHROPIC_', 'CLAUDE_CODE_', 'OPENAI_', 'AWS_'];
const ISOLATED_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']);

const preserved = new Set(
  (process.env.VITEST_PRESERVE_ENV ?? '')
    .split(',')
    .filter(Boolean)
    .map((name) => name.toUpperCase())
);

for (const key of Object.keys(process.env)) {
  // process.env is case-insensitive on Windows and keeps the key's actual case, so compare upper-cased.
  const name = key.toUpperCase();
  const isolated = ISOLATED_NAMES.has(name) || ISOLATED_PREFIXES.some((prefix) => name.startsWith(prefix));
  if (isolated && !preserved.has(name)) {
    delete process.env[key];
  }
}
