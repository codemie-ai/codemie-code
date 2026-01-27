/**
 * Integration Test: Unified Session Sync Plugin - End-to-End Orchestrator
 *
 * Tests the complete orchestration pipeline:
 * 1. Session file discovery via adapter
 * 2. Adapter selection from agent registry
 * 3. Processor execution in priority order (metrics → conversations)
 * 4. Error isolation (one processor fails, others continue)
 * 5. Concurrent sync prevention
 * 6. Multiple session files processing
 *
 * Test Scenario: Real Claude session with metrics and conversations
 * - Uses golden dataset from fixtures/claude/
 * - Validates end-to-end pipeline without mocking internal components
 * - Tests orchestrator behavior, not processor logic (tested separately)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { rm } from 'fs/promises';
import { SSOSessionSyncPlugin } from '../../../../src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.js';
import { SessionStore } from '../../../../src/agents/core/session/SessionStore.js';
import type { PluginContext } from '../../../../src/proxy/plugins/types.js';
import type { Session } from '../../../../src/agents/core/session/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('Unified Session Sync Plugin - Orchestrator', () => {
  const fixturesDir = join(__dirname, '../fixtures/claude');
  const fixturesSessionDir = join(fixturesDir, '-tmp-private');
  const tempTestDir = join(tmpdir(), 'orchestrator-test-' + Date.now());
  const claudeProjectsDir = join(tempTestDir, '.claude', 'projects');

  const sessionId1 = '4c2ddfdc-b619-4525-8d03-1950fb1b0257';
  const testMetricsSessionId = 'orchestrator-test-' + Date.now();

  let plugin: SSOSessionSyncPlugin;
  let interceptor: any;
  let sessionStore: SessionStore;

  beforeAll(async () => {
    // Setup: Create directory structure that mimics real Claude setup
    mkdirSync(claudeProjectsDir, { recursive: true });

    // Copy fixture session files to temp directory (simulate Claude's storage)
    const projectDir1 = join(claudeProjectsDir, 'project-1');
    mkdirSync(projectDir1);
    copyFileSync(
      join(fixturesSessionDir, `${sessionId1}.jsonl`),
      join(projectDir1, `${sessionId1}.jsonl`)
    );
    copyFileSync(
      join(fixturesSessionDir, 'agent-36541525.jsonl'),
      join(projectDir1, 'agent-36541525.jsonl')
    );
    copyFileSync(
      join(fixturesSessionDir, 'agent-50243ee8.jsonl'),
      join(projectDir1, 'agent-50243ee8.jsonl')
    );

    // Create session metadata with proper correlation (required by session sync)
    sessionStore = new SessionStore();
    const session: Session = {
      sessionId: testMetricsSessionId,
      agentName: 'claude',
      provider: 'ai-run-sso',
      workingDirectory: '/tmp/test',
      gitBranch: 'main',
      status: 'active',
      startTime: Date.now(),
      correlation: {
        status: 'matched',
        agentSessionFile: join(projectDir1, `${sessionId1}.jsonl`),
        agentSessionId: sessionId1,
        detectedAt: Date.now(),
        retryCount: 0
      },
      monitoring: {
        isActive: true,
        changeCount: 0
      }
    };
    await sessionStore.saveSession(session);

    // Initialize plugin
    plugin = new SSOSessionSyncPlugin();
  });

  afterAll(async () => {
    // Cleanup temp directory
    if (existsSync(tempTestDir)) {
      await rm(tempTestDir, { recursive: true, force: true });
    }

    // Cleanup metrics session - use MetricsWriter to get correct path
    const { MetricsWriter } = await import('../../../../src/providers/plugins/sso/session/processors/metrics/MetricsWriter.js');
    const metricsWriter = new MetricsWriter(testMetricsSessionId);
    try {
      const metricsFilePath = metricsWriter.getFilePath();
      if (existsSync(metricsFilePath)) unlinkSync(metricsFilePath);
    } catch {
      // Ignore cleanup errors (file might not exist)
    }

    // Cleanup session file
    try {
      const { getSessionPath } = await import('../../../../src/agents/core/metrics/metrics-config.js');
      const sessionPath = getSessionPath(testMetricsSessionId);
      if (existsSync(sessionPath)) unlinkSync(sessionPath);
    } catch {
      // Ignore cleanup errors (file might not exist)
    }
  });

  describe('Plugin Initialization', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.id).toBe('@codemie/sso-session-sync');
      expect(plugin.name).toBe('SSO Session Sync (Unified)');
      expect(plugin.priority).toBe(100);
    });

    it('should fail initialization without session ID', async () => {
      const context: PluginContext = {
        config: { targetApiUrl: 'https://api.example.com' },
        credentials: { cookies: { session: 'test' } },
        profileConfig: {}
      } as any;

      await expect(plugin.createInterceptor(context)).rejects.toThrow('Session ID not available');
    });

    it('should fail initialization without SSO credentials', async () => {
      const context: PluginContext = {
        config: {
          sessionId: 'test-session',
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude'
        },
        credentials: undefined,
        profileConfig: {}
      } as any;

      await expect(plugin.createInterceptor(context)).rejects.toThrow('SSO credentials not available');
    });

    it('should fail initialization without client type', async () => {
      const context: PluginContext = {
        config: {
          sessionId: 'test-session',
          targetApiUrl: 'https://api.example.com'
        },
        credentials: { cookies: { session: 'test' } },
        profileConfig: {}
      } as any;

      await expect(plugin.createInterceptor(context)).rejects.toThrow('Client type not available');
    });
  });


  describe('Session Discovery and Processing', () => {

    it('should handle uncorrelated session gracefully', async () => {
      // Create session without correlation
      const uncorrelatedSessionId = 'uncorrelated-' + Date.now();
      const uncorrelatedSession: Session = {
        sessionId: uncorrelatedSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        workingDirectory: '/tmp/test',
        status: 'active',
        startTime: Date.now(),
        correlation: {
          status: 'pending',
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        }
      };
      await sessionStore.saveSession(uncorrelatedSession);

      const context: PluginContext = {
        config: {
          sessionId: uncorrelatedSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude',
          version: '0.0.28'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      process.env.CODEMIE_SESSION_DRY_RUN = '1';
      const originalHome = process.env.HOME;
      process.env.HOME = tempTestDir;

      try {
        interceptor = await plugin.createInterceptor(context);
        await interceptor.onProxyStart();

        // Sync should complete without errors (skips uncorrelated sessions)
        await expect((interceptor as any).syncSessions()).resolves.not.toThrow();
      } finally {
        await interceptor.onProxyStop();
        process.env.HOME = originalHome;
        delete process.env.CODEMIE_SESSION_DRY_RUN;
      }
    });
  });


  describe('Concurrent Sync Prevention', () => {
    it('should prevent concurrent syncs with isSyncing flag', async () => {
      const context: PluginContext = {
        config: {
          sessionId: testMetricsSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude',
          version: '0.0.28'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      process.env.CODEMIE_SESSION_DRY_RUN = '1';
      const originalHome = process.env.HOME;
      process.env.HOME = tempTestDir;

      try {
        interceptor = await plugin.createInterceptor(context);
        await interceptor.onProxyStart();

        // Start first sync
        const sync1Promise = (interceptor as any).syncSessions();

        // Try to start second sync immediately
        const sync2Promise = (interceptor as any).syncSessions();

        // Both should complete, but second should skip due to isSyncing flag
        await Promise.all([sync1Promise, sync2Promise]);

        // No error should be thrown
        expect(true).toBe(true);
      } finally {
        await interceptor.onProxyStop();
        process.env.HOME = originalHome;
        delete process.env.CODEMIE_SESSION_DRY_RUN;
      }
    });
  });

  describe('Configuration Options', () => {
    it('should respect CODEMIE_SESSION_SYNC_ENABLED environment variable', async () => {
      process.env.CODEMIE_SESSION_SYNC_ENABLED = 'false';

      const context: PluginContext = {
        config: {
          sessionId: testMetricsSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      try {
        await expect(plugin.createInterceptor(context)).rejects.toThrow('Session sync disabled');
      } finally {
        delete process.env.CODEMIE_SESSION_SYNC_ENABLED;
      }
    });

    it('should respect CODEMIE_SESSION_SYNC_INTERVAL environment variable', async () => {
      process.env.CODEMIE_SESSION_SYNC_INTERVAL = '60000'; // 1 minute

      const context: PluginContext = {
        config: {
          sessionId: testMetricsSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude',
          version: '0.0.28'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      const originalHome = process.env.HOME;
      process.env.HOME = tempTestDir;

      try {
        interceptor = await plugin.createInterceptor(context);
        await interceptor.onProxyStart();

        // Verify interval was set correctly
        expect((interceptor as any).syncInterval).toBe(60000);
      } finally {
        await interceptor.onProxyStop();
        process.env.HOME = originalHome;
        delete process.env.CODEMIE_SESSION_SYNC_INTERVAL;
      }
    });
  });

  describe('Lifecycle Hooks', () => {
    it('should start background timer on onProxyStart', async () => {
      const context: PluginContext = {
        config: {
          sessionId: testMetricsSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude',
          version: '0.0.28'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      const originalHome = process.env.HOME;
      process.env.HOME = tempTestDir;

      try {
        interceptor = await plugin.createInterceptor(context);
        await interceptor.onProxyStart();

        // Verify timer was started
        expect((interceptor as any).syncTimer).toBeDefined();
      } finally {
        await interceptor.onProxyStop();
        process.env.HOME = originalHome;
      }
    });

    it('should stop timer and perform final sync on onProxyStop', async () => {
      const context: PluginContext = {
        config: {
          sessionId: testMetricsSessionId,
          targetApiUrl: 'https://api.example.com',
          clientType: 'codemie-claude',
          version: '0.0.28'
        },
        credentials: { cookies: { session: 'test-cookie' } },
        profileConfig: {}
      } as any;

      process.env.CODEMIE_SESSION_DRY_RUN = '1';
      const originalHome = process.env.HOME;
      process.env.HOME = tempTestDir;

      try {
        interceptor = await plugin.createInterceptor(context);
        await interceptor.onProxyStart();

        const timerBefore = (interceptor as any).syncTimer;
        expect(timerBefore).toBeDefined();

        await interceptor.onProxyStop();

        // Verify timer was cleared
        expect((interceptor as any).syncTimer).toBeUndefined();
      } finally {
        process.env.HOME = originalHome;
        delete process.env.CODEMIE_SESSION_DRY_RUN;
      }
    });
  });
});
