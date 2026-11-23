import { defineConfig, defineProject } from 'vitest/config';
import { tmpdir } from 'os';
import { join } from 'path';

const agentMaxWorkers = (() => {
  const n = parseInt(process.env.CI_AGENT_MAX_WORKERS ?? '', 10);
  return Number.isNaN(n) || n < 1 ? 2 : n;
})();

// Includes this config-eval process's pid so concurrent `vitest run` invocations
// (e.g. two CI jobs, or a local run alongside watch mode) never share a log directory.
const testCodemieHome = join(tmpdir(), `codemie-test-home-${process.pid}`);

// Shared by every project. Its keys are exempt from tests/setup/clean-env.ts, which removes
// inherited CODEMIE_*/ANTHROPIC_* and similar variables: VITEST_PRESERVE_ENV lists them for it.
const sharedTestEnv = {
  FORCE_COLOR: '1',
  NODE_ENV: 'test',
  CODEMIE_HOME: testCodemieHome,
};
const testEnv = {
  ...sharedTestEnv,
  VITEST_PRESERVE_ENV: Object.keys(sharedTestEnv).join(','),
};

export default defineConfig({
  test: {
    projects: [
      // ── Unit tests (src/) ────────────────────────────────────────────────
      defineProject({
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
          globals: true,
          environment: 'node',
          testTimeout: 30_000,
          // Increased from 10_000: WSL2 filesystem (on /mnt/c Windows path) causes
          // cold-start module loading to exceed 10 s. 30 s gives enough headroom.
          hookTimeout: 30_000,
          isolate: true,
          // Drop inherited CODEMIE_*/ANTHROPIC_* (e.g. from a codemie-claude session)
          setupFiles: ['./tests/setup/clean-env.ts'],
          env: testEnv,
          coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: [
              'node_modules/',
              'dist/',
              '**/*.test.ts',
              '**/*.spec.ts',
              '**/types.ts',
              'bin/',
              'tests/',
            ],
          },
        },
        resolve: {
          alias: { '@': '/src' },
        },
      }),

      // ── CLI integration tests (no network auth) ──────────────────────────
      defineProject({
        test: {
          name: 'cli',
          include: ['tests/integration/**/*.test.ts'],
          exclude: ['tests/integration/agent-*.test.ts'],
          globals: true,
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 10_000,
          isolate: true,
          sequence: { groupOrder: 1 },
          // Same isolation as the unit project: these tests spawn the CLI and inherit the worker env
          setupFiles: ['./tests/setup/clean-env.ts'],
          env: testEnv,
        },
        resolve: {
          alias: { '@': '/src' },
        },
      }),

      // ── Agent integration tests (real network, SSO/JWT auth) ─────────────
      defineProject({
        test: {
          name: 'agent',
          include: ['tests/integration/agent-*.test.ts'],
          globalSetup: ['tests/setup/agent-build-setup.ts'],
          testTimeout: 180_000,
          hookTimeout: 300_000,
          maxWorkers: agentMaxWorkers,
          isolate: true,
          sequence: { groupOrder: 2 },
          reporters: ['verbose'],
          env: testEnv,
        },
        resolve: {
          alias: { '@': '/src' },
        },
      }),
    ],
  },
});
