import { defineConfig, defineProject } from 'vitest/config';

const agentMaxWorkers = (() => {
  const n = parseInt(process.env.CI_AGENT_MAX_WORKERS ?? '', 10);
  return Number.isNaN(n) || n < 1 ? 2 : n;
})();

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
          hookTimeout: 10_000,
          isolate: true,
          env: {
            FORCE_COLOR: '1',
            NODE_ENV: 'test',
          },
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
          env: {
            FORCE_COLOR: '1',
            NODE_ENV: 'test',
          },
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
          env: {
            FORCE_COLOR: '1',
            NODE_ENV: 'test',
          },
        },
        resolve: {
          alias: { '@': '/src' },
        },
      }),
    ],
  },
});
