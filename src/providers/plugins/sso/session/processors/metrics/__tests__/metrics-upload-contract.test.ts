/**
 * Metrics upload contract (unit)
 *
 * Pins the wire + auth contract of the exported MetricsSender against a LOCAL
 * mock HTTP server (no real network). Covers:
 * - POST target (<baseUrl>/v1/metrics), method, headers
 * - auth header selection: Cookie (SSO) vs user-id (apiKey / localhost dev)
 * - X-CodeMie-* / version / client-type headers + session-start payload shape
 * - 5xx -> retry -> success
 * - 401 and HTML-login-page 200 classified as auth failure -> marker written
 * - successful send clears a pre-existing marker
 * - dryRun performs NO request
 *
 * All behaviors were probed against the compiled implementation first; these
 * assertions pin the CURRENT contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetricsSender } from '../metrics-api-client.js';
import type { SessionMetric } from '../metrics-types.js';
import { logger } from '../../../../../../../utils/logger.js';

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Responder = (req: http.IncomingMessage, res: http.ServerResponse, requestIndex: number) => void;

/** A local HTTP server that captures every request and delegates the response. */
class MockServer {
  readonly captured: CapturedRequest[] = [];
  private server!: http.Server;
  private port = 0;

  async start(responder: Responder): Promise<void> {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        this.captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        responder(req, res, this.captured.length);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()));
    this.port = (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get last(): CapturedRequest {
    return this.captured[this.captured.length - 1];
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const jsonOk: Responder = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ success: true, message: 'ok' }));
};

// Minimal session shape accepted by sendSessionStart/sendSessionEnd.
function makeSession(workingDirectory: string): Parameters<MetricsSender['sendSessionStart']>[0] {
  return {
    sessionId: 'sess-123',
    agentName: 'claude',
    provider: 'ai-run-sso',
    project: 'demo-project',
    startTime: Date.now(),
    workingDirectory,
    repository: 'owner/repo',
    model: 'gpt-test',
  };
}

describe('MetricsSender upload contract', () => {
  let home: string;
  let markerPath: string;
  let originalHome: string | undefined;
  let server: MockServer | undefined;

  beforeEach(() => {
    // Isolate CODEMIE_HOME so the analytics-auth-status marker lands in temp,
    // never the developer's real ~/.codemie.
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'metrics-upload-'));
    process.env.CODEMIE_HOME = home;
    markerPath = join(home, 'analytics-auth-status.json');
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    // Flush and close the singleton logger's write stream before deleting the
    // temp home: it opens the log file asynchronously, and deleting the
    // directory mid-open surfaces as an unhandled ENOENT later in the run.
    await logger.close();
    // Windows can briefly hold a handle (logger) on files under the temp home;
    // retry and never let a cleanup failure fail the test.
    try { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
  });

  it('POSTs a session-start to <baseUrl>/v1/metrics with the expected metric name and attributes', async () => {
    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({
      baseUrl: server.baseUrl,
      cookies: 'session=abc',
      version: '9.9.9',
      clientType: 'codemie-claude',
    });

    const resp = await sender.sendSessionStart(makeSession(home), home, { status: 'started' });

    expect(resp).toEqual({ success: true, message: 'ok' });
    expect(server.captured).toHaveLength(1);
    expect(server.last.method).toBe('POST');
    expect(server.last.url).toBe('/v1/metrics');

    const payload = JSON.parse(server.last.body) as SessionMetric;
    expect(payload.name).toBe('codemie_cli_session_total');
    expect(payload.name).toBe(MetricsSender.METRIC_SESSION_TOTAL);
    expect(payload.attributes.agent).toBe('claude');
    expect(payload.attributes.session_id).toBe('sess-123');
    expect(payload.attributes.repository).toBe('owner/repo');
    expect(payload.attributes.project).toBe('demo-project');
    expect(payload.attributes.count).toBe(1);
    expect((payload.attributes as { status: string }).status).toBe('started');
    expect(payload.attributes.schema_version).toBe(2);
  });

  it('sends the Cookie header (not user-id) when cookies are configured, plus X-CodeMie-* / version / client-type headers', async () => {
    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({
      baseUrl: server.baseUrl,
      cookies: 'session=abc',
      version: '9.9.9',
      clientType: 'codemie-claude',
    });
    await sender.sendSessionStart(makeSession(home), home, { status: 'started' });

    const h = server.last.headers;
    expect(h['cookie']).toBe('session=abc');
    expect(h['user-id']).toBeUndefined();
    expect(h['content-type']).toBe('application/json');
    expect(h['user-agent']).toBe('codemie-cli/9.9.9');
    expect(h['x-codemie-cli']).toBe('codemie-cli/9.9.9');
    expect(h['x-codemie-client']).toBe('codemie-claude');
    expect(h['x-codemie-repository']).toBe('owner/repo');
    expect(h['x-codemie-project']).toBe('demo-project');
    // branch header is always present (empty in a non-git temp dir)
    expect(h).toHaveProperty('x-codemie-branch');
  });

  it('uses the user-id header (localhost dev) when apiKey is set and omits the Cookie header', async () => {
    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({ baseUrl: server.baseUrl, apiKey: 'dev-api-key', cookies: 'session=abc' });
    await sender.sendSessionStart(makeSession(home), home, { status: 'started' });

    // apiKey takes precedence over cookies
    expect(server.last.headers['user-id']).toBe('dev-api-key');
    expect(server.last.headers['cookie']).toBeUndefined();
  });

  it('retries a 5xx response and then succeeds', async () => {
    server = new MockServer();
    await server.start((_req, res, index) => {
      if (index === 1) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'internal error' }));
      } else {
        jsonOk(_req, res, index);
      }
    });

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'session=abc', retryAttempts: 3 });
    const resp = await sender.sendSessionEnd(makeSession(home), home, { status: 'completed' }, 4321);

    expect(resp).toEqual({ success: true, message: 'ok' });
    // Exactly one retry: the failed attempt plus the successful retry.
    expect(server.captured).toHaveLength(2);
  }, 15000);

  it('classifies a 401 as an auth failure: throws and writes the analytics-auth-status marker', async () => {
    server = new MockServer();
    await server.start((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'unauthorized' }));
    });

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'expired=1', retryAttempts: 0 });

    await expect(sender.sendSessionStart(makeSession(home), home, { status: 'started' })).rejects.toThrow(/401/);

    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as {
      status: string;
      reason: string;
      baseUrl: string;
    };
    expect(marker.status).toBe('invalid');
    expect(marker.reason).toContain('HTTP 401');
    expect(marker.baseUrl).toBe(server.baseUrl);
  });

  it('classifies an HTML login-page 200 response as an auth failure and writes the marker', async () => {
    server = new MockServer();
    await server.start((_req, res) => {
      // Keycloak answers expired cookies with HTTP 200 + an HTML login page.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Sign in</body></html>');
    });

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'expired=1', retryAttempts: 0 });

    await expect(sender.sendSessionStart(makeSession(home), home, { status: 'started' })).rejects.toThrow(/non-JSON/);

    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8')) as { status: string };
    expect(marker.status).toBe('invalid');
  });

  it('clears a pre-existing auth-status marker after a successful send', async () => {
    // Seed a stale invalid marker.
    writeFileSync(
      markerPath,
      JSON.stringify({ status: 'invalid', reason: 'stale', baseUrl: 'http://old', detectedAt: 1 }),
      'utf-8',
    );
    expect(existsSync(markerPath)).toBe(true);

    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'session=abc' });
    await sender.sendSessionStart(makeSession(home), home, { status: 'started' });

    expect(existsSync(markerPath)).toBe(false);
  });

  it('makes NO HTTP request in dryRun mode and returns a dry-run response', async () => {
    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'session=abc', dryRun: true });
    const resp = await sender.sendSessionStart(makeSession(home), home, { status: 'started' });

    expect(resp.success).toBe(true);
    expect(resp.message).toContain('[DRY-RUN]');
    expect(server.captured).toHaveLength(0);
  });

  it('sends aggregated tool-usage metrics verbatim via sendSessionMetric', async () => {
    server = new MockServer();
    await server.start(jsonOk);

    const sender = new MetricsSender({ baseUrl: server.baseUrl, cookies: 'session=abc' });
    const metric: SessionMetric = {
      name: MetricsSender.METRIC_TOOL_USAGE_TOTAL,
      attributes: {
        agent: 'claude',
        agent_version: '1.0.0',
        codemie_client: 'codemie-cli',
        repository: 'owner/repo',
        session_id: 'sess-123',
        branch: 'main',
        count: 1,
        llm_model: 'gpt-test',
        total_user_prompts: 3,
        session_duration_ms: 1000,
        had_errors: false,
        tool_names: ['Read', 'Edit'],
        total_tool_calls: 2,
        successful_tool_calls: 2,
        failed_tool_calls: 0,
        files_created: 0,
        files_modified: 1,
        files_deleted: 0,
        total_lines_added: 5,
        total_lines_removed: 1,
      },
    };

    const resp = await sender.sendSessionMetric(metric);
    expect(resp).toEqual({ success: true, message: 'ok' });

    const payload = JSON.parse(server.last.body) as SessionMetric;
    expect(payload.name).toBe('codemie_cli_tool_usage_total');
    expect((payload.attributes as { tool_names: string[] }).tool_names).toEqual(['Read', 'Edit']);
  });
});
