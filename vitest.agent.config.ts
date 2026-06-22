import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Picks up all agent-*.test.ts files (agent-jwt-basic, agent-jwt-models,
    // agent-jwt-budget, agent-interactive-session, agent-assistant, agent-skills)
    include: ['tests/integration/agent-*.test.ts'],
    globalSetup: ['tests/setup/agent-build-setup.ts'],
    testTimeout: 180_000,  // 3 min — real agent calls over the network
    hookTimeout: 300_000,  // 5 min — covers build + token fetch in beforeAll
    reporters: ['verbose'],
    env: {
      FORCE_COLOR: '1',
      NODE_ENV: 'test',
    },
    maxWorkers: parseInt(process.env.CI_AGENT_MAX_WORKERS ?? '2', 10),
    isolate: true,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});
