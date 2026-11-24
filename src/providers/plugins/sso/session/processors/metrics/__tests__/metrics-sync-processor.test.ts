/**
 * MetricsSyncProcessor against a local HTTP server: the aggregated payload it uploads.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetricsSyncProcessor } from '../metrics-sync-processor.js';
import * as metricsApiClient from '../metrics-api-client.js';
import { logger } from '../../../../../../../utils/logger.js';
import type { ParsedSession } from '../../../BaseSessionAdapter.js';
import { connectFolder, disconnectFolder, resolveConsent } from '@/agents/core/evidence/consent-store.js';
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
  let reply: { status: number; body: unknown };

  beforeEach(async () => {
    reply = { status: 200, body: { success: true, message: 'ok' } };
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
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
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

  async function syncDeltas(
    deltas: Array<ReturnType<typeof delta>>,
    contextExtras: Partial<ProcessingContext> = {},
    sessionExtras: Record<string, unknown> = {}
  ) {
    writeFileSync(join(home, 'sessions', `${SESSION_ID}.json`), JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.parse('2026-11-01T09:00:00Z'),
      workingDirectory: '/tmp/work',
      gitBranch: 'main',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: 'agent-1', retryCount: 0 },
      ...sessionExtras
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
      dryRun: false,
      ...contextExtras
    } as ProcessingContext;

    return new MetricsSyncProcessor().process(
      { sessionId: SESSION_ID, agentName: 'claude', metadata: {}, messages: [] } as ParsedSession,
      context
    );
  }

  describe('EPMCDME-17054 legacy work-consent gate', () => {
    const scope = { api_identity: 'api-x', owner_hash: 'owner-x', project: 'test321' };
    let folder: string;

    beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'metrics-sync-repo-')); });
    afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

    const readDeltas = (): Array<{ syncStatus: string; syncAttempts: number }> =>
      readFileSync(join(home, 'sessions', `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));

    const readRecord = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(home, 'sessions', `${SESSION_ID}.json`), 'utf-8'));

    it('an anthropic-subscription session without frozen consent sends no delta and persists the final verdict', async () => {
      const send = vi.spyOn(metricsApiClient.MetricsSender.prototype, 'sendSessionMetric');
      try {
        const result = await syncDeltas([delta('p-1', 'pending'), delta('p-2', 'pending')], {}, {
          provider: 'anthropic-subscription', project: 'test321', workingDirectory: folder
        });

        expect(result.success).toBe(true);
        expect(send).not.toHaveBeenCalled();
        expect(bodies).toEqual([]);
        expect(readDeltas().map(d => [d.syncStatus, d.syncAttempts])).toEqual([['pending', 0], ['pending', 0]]);
        expect(readRecord().legacyMetricsWithheld).toBe('no-work-consent');
      } finally {
        send.mockRestore();
      }
    });

    it('consent revoked after the end metric was sent: the deltas withheld for good are persisted as such', async () => {
      await connectFolder(scope, folder);
      const ref = await resolveConsent(scope, folder);
      await disconnectFolder(scope, folder);

      const result = await syncDeltas([delta('p-1', 'pending')], {}, {
        provider: 'anthropic-subscription', project: 'test321', workingDirectory: folder, endMetricSentAt: 1,
        legacyMetricsConsent: { ref, apiIdentity: 'api-x', ownerHash: 'owner-x' }
      });

      expect(result.success).toBe(true);
      expect(bodies).toEqual([]);
      expect(readRecord()).toMatchObject({ endMetricSentAt: 1, legacyMetricsWithheld: 'consent-revoked' });
    });

    it('an anthropic-subscription session whose frozen consent holds waits for the backend to accept its destination', async () => {
      await connectFolder(scope, folder);
      const ref = await resolveConsent(scope, folder);

      const result = await syncDeltas([delta('p-1', 'pending'), delta('p-2', 'pending')], {}, {
        provider: 'anthropic-subscription', project: 'test321', workingDirectory: folder,
        legacyMetricsConsent: { ref, apiIdentity: 'api-x', ownerHash: 'owner-x' }
      });

      expect(result).toMatchObject({ success: true, message: 'legacy metrics withheld: destination-unconfirmed' });
      expect(bodies).toEqual([]);
      expect(readDeltas().map(d => d.syncStatus)).toEqual(['pending', 'pending']);
      expect(readRecord().legacyMetricsWithheld).toBeUndefined();
    });

    it('an anthropic-subscription session whose frozen consent holds sends its deltas once the backend accepted it', async () => {
      await connectFolder(scope, folder);
      const ref = await resolveConsent(scope, folder);
      const { writeAccepted } = await import('@/agents/core/evidence/accepted-marker.js');
      const { recordKey } = await import('@/agents/core/evidence/record-store.js');
      await writeAccepted(recordKey('api-x', 'owner-x', 'agent-1'), 'agent-1', 'test321');

      const result = await syncDeltas([delta('p-1', 'pending'), delta('p-2', 'pending')], {}, {
        provider: 'anthropic-subscription', project: 'test321', workingDirectory: folder,
        legacyMetricsConsent: { ref, apiIdentity: 'api-x', ownerHash: 'owner-x' }
      });

      expect(result.success).toBe(true);
      expect(bodies).toHaveLength(1);
      expect(readDeltas().map(d => d.syncStatus)).toEqual(['synced', 'synced']);
    });
  });

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

  describe('line model: no attempt cap, a rejected status', () => {
    const readStatuses = (): Array<{ syncStatus: string; syncAttempts: number }> =>
      readFileSync(join(home, 'sessions', `${SESSION_ID}_metrics.jsonl`), 'utf-8').trim().split('\n').map(l => JSON.parse(l));

    it('a failed delta with syncAttempts 7 is still a send candidate', async () => {
      const { isDeltaSendCandidate } = await import('../metrics-sync-processor.js');
      expect(isDeltaSendCandidate({ syncStatus: 'failed', syncAttempts: 7 })).toBe(true);
      expect(isDeltaSendCandidate({ syncStatus: 'rejected', syncAttempts: 1 })).toBe(false);
      expect(isDeltaSendCandidate({ syncStatus: 'synced', syncAttempts: 1 })).toBe(false);
    });

    it('a JSON 400 marks the delta rejected and it is never resent', async () => {
      reply = { status: 400, body: { code: 400, message: 'bad metric', details: 'no' } };
      await syncDeltas([delta('r-1', 'pending')]);
      expect(readStatuses().map(d => d.syncStatus)).toEqual(['rejected']);

      const sent = bodies.length;
      reply = { status: 200, body: { success: true, message: 'ok' } };
      await syncDeltas([{ ...delta('r-1', 'pending'), syncStatus: 'rejected' as never }]);
      expect(bodies).toHaveLength(sent);
    });

    it('a JSON 404 marks the delta failed and one process() call sends the line once', async () => {
      reply = { status: 404, body: { code: 404, message: 'nope', details: '' } };
      await syncDeltas([delta('f-1', 'pending', { syncAttempts: 7 })]);
      expect(readStatuses().map(d => [d.syncStatus, d.syncAttempts])).toEqual([['failed', 8]]);
      expect(bodies).toHaveLength(1);
    });
  });

  describe('credentials-superseded check', () => {
    let senderSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      senderSpy = vi.spyOn(metricsApiClient, 'MetricsSender');
    });

    afterEach(() => {
      senderSpy.mockRestore();
    });

    it('hands the context check to the metrics sender', async () => {
      const credentialsSuperseded = async (): Promise<boolean> => true;

      await syncDeltas([delta('a-1', 'pending', { models: ['m'] })], { credentialsSuperseded });

      expect(senderSpy).toHaveBeenCalledTimes(1);
      expect(senderSpy.mock.calls[0][0]).toMatchObject({ credentialsSuperseded });
    });

    it('leaves the sender check absent when the context has none', async () => {
      await syncDeltas([delta('a-1', 'pending', { models: ['m'] })]);

      expect(senderSpy).toHaveBeenCalledTimes(1);
      expect((senderSpy.mock.calls[0][0] as { credentialsSuperseded?: unknown }).credentialsSuperseded).toBeUndefined();
    });
  });
});
