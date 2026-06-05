import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    // Force color output for consistent test behavior (chalk output length varies with/without colors)
    env: {
      FORCE_COLOR: '1',
      NODE_ENV: 'test', // Skip auto-update checks during testing
    },

    // Enable parallel execution with isolated environments, serial execution — concurrent agent processes drop session files on low-spec machines   
    maxWorkers: parseInt(process.env.CI_AGENT_MAX_WORKERS ?? '2', 10),
    // Isolate each test file for safety
    isolate: true,

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
    testTimeout: 30000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
