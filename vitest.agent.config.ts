import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Picks up all agent-*.test.ts files:
    // agent-task (TC-016), agent-task-session, agent-negative (TC-018/019),
    // agent-jwt-basic (TC-017), agent-jwt-token (TC-027), agent-jwt-budget (TC-028),
    // agent-model (TC-020/021/024), agent-assistant (TC-014/015/026),
    // agent-skills (TC-025), agent-shortcuts
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
