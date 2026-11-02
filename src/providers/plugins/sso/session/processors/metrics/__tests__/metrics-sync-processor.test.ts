/**
 * MetricsSyncProcessor against a local HTTP server: the aggregated payload it uploads.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetricsSyncProcessor } from '../metrics-sync-processor.js';
import { logger } from '../../../../../../../utils/logger.js';
import type { ParsedSession } from '../../../BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../BaseProcessor.js';

const SESSION_ID = 'sync-model-session';

const delta = (recordId: string, syncStatus: 'pending' | 'synced', extra: Record<string, unknown> = {}) => ({
  recordId,
  sessionId: SESSION_ID,
  agentSessionId: 'agent-1',
  timestamp: Date.parse('2026-11-01T10:00:00Z'),
  gitBranch: 'main',
  syncStatus,
  syncAttempts: syncStatus === 'synced' ? 1 : 0,
  ...extra
});

describe('MetricsSyncProcessor', () => {
  let home: string;
  let originalHome: string | undefined;
  let server: http.Server;
  let bodies: string[];

  beforeEach(async () => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'metrics-sync-'));
    process.env.CODEMIE_HOME = home;
    mkdirSync(join(home, 'sessions'), { recursive: true });
    bodies = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        bodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'ok' }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    await logger.close();
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  async function syncDeltas(deltas: Array<ReturnType<typeof delta>>) {
    writeFileSync(join(home, 'sessions', `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.parse('2026-11-01T09:00:00Z'),
      workingDirectory: '/tmp/work',
      gitBranch: 'main',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: 'agent-1', retryCount: 0 }
    }));
    writeFileSync(
      join(home, 'sessions', `${SESSION_ID}_metrics.jsonl`),
      deltas.map(d => JSON.stringify(d)).join('\n') + '\n'
    );
    const { port } = server.address() as AddressInfo;
    const context = {
      apiBaseUrl: `http://127.0.0.1:${port}`,
      cookies: 'session=abc',
      clientType: 'codemie-cli',
      version: '1.0.0',
      dryRun: false
    } as ProcessingContext;

    return new MetricsSyncProcessor().process(
      { sessionId: SESSION_ID, agentName: 'claude', metadata: {}, messages: [] } as ParsedSession,
      context
    );
  }

  it('a prompts-only batch carries the model of the last synced reply', async () => {
    const result = await syncDeltas([
      delta('a-1', 'synced', { models: ['claude-sonnet-5'] }),
      delta('u-2:prompts', 'pending', { userPrompts: [{ count: 1, text: 'story' }] })
    ]);

    expect(result.success).toBe(true);
    expect(bodies.map(body => JSON.parse(body).attributes.llm_model)).toEqual(['claude-sonnet-5']);
  });

  it('a prompts-only branch keeps its own last model when another branch has a modeled reply pending', async () => {
    const result = await syncDeltas([
      delta('b-1', 'synced', { gitBranch: 'B', models: ['model-B'] }),
      delta('a-2', 'pending', { gitBranch: 'A', models: ['model-A'] }),
      delta('u-3:prompts', 'pending', { gitBranch: 'B', userPrompts: [{ count: 1, text: 'story' }] })
    ]);

    expect(result.success).toBe(true);
    const uploaded = bodies.map(body => JSON.parse(body).attributes);
    expect(Object.fromEntries(uploaded.map(a => [a.branch, a.llm_model]))).toEqual({ A: 'model-A', B: 'model-B' });
    expect(uploaded).toHaveLength(2);
  });

  it('a prompts-only branch with no model history of its own carries the session\'s last model', async () => {
    const result = await syncDeltas([
      delta('a-1', 'synced', { models: ['model-X'] }),
      delta('u-2:prompts', 'pending', { gitBranch: 'feature', userPrompts: [{ count: 1, text: 'story' }] })
    ]);

    expect(result.success).toBe(true);
    expect(bodies.map(body => JSON.parse(body).attributes.llm_model)).toEqual(['model-X']);
  });
});
