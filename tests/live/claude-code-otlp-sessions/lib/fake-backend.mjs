// Fake CodeMie analytics backend on 127.0.0.1. Records every request (method, path, headers, body,
// arrival time) and answers just enough for the forwarder to treat deliveries as accepted.
import { createServer } from 'node:http';

const ROUTES = {
  hooks: '/v1/analytics/cli-analytics/event-hooks',
  logs: '/v1/analytics/cli-analytics/logs',
  metrics: '/v1/analytics/cli-analytics/metrics',
  traces: '/v1/analytics/cli-analytics/traces',
  policy: '/v1/analytics/cli-analytics/classification-policy',
};

function kindOf(path) {
  if (path === ROUTES.hooks) return 'hooks';
  if (path === ROUTES.logs) return 'otlp-logs';
  if (path === ROUTES.metrics) return 'otlp-metrics';
  if (path === ROUTES.traces) return 'otlp-traces';
  if (path === ROUTES.policy) return 'policy';
  if (path === '/v1/metrics') return 'legacy-metrics';
  return 'other';
}

/**
 * @param {{ policy?: 'contract'|'legacy'|object, email?: string, onRequest?: (rec: object) => (void|object) }} opts
 *   policy 'contract' (default): classification-policy advertises publication contract 1 and every ingest answer echoes
 *   it (X-CodeMie-Publication-Contract / -Destination / -Bound-Project), as the real backend does for the new contract.
 *   policy 'legacy': the policy endpoint answers 404 (a backend without the evidence contract).
 *   onRequest may return {status, body, headers} to override the answer (fault injection).
 */
export async function createFakeBackend({ policy = 'contract', email = 'live.tester@example.com', onRequest } = {}) {
  const requests = [];
  const startedAt = Date.now();
  let seq = 0;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://127.0.0.1');
      const text = raw.toString('utf8');
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      const rec = {
        seq: seq++,
        at: Date.now(),
        atIso: new Date().toISOString(),
        tRelMs: Date.now() - startedAt,
        method: req.method,
        path: u.pathname,
        query: u.search,
        kind: kindOf(u.pathname),
        headers: { ...req.headers },
        bodyBytes: raw.length,
        body: text,
        json,
      };
      requests.push(rec);
      let override;
      try { override = onRequest?.(rec); } catch { /* ignore */ }
      if (override && typeof override === 'object') {
        res.writeHead(override.status ?? 200, { 'content-type': 'application/json', ...(override.headers ?? {}) });
        res.end(override.body === undefined ? '{}' : typeof override.body === 'string' ? override.body : JSON.stringify(override.body));
        return;
      }
      if (rec.kind === 'policy') {
        if (policy === 'legacy') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(policy === 'contract' ? { organizations: [], version: 'live-1', publication_contracts: ['1'] } : policy));
        return;
      }
      if (u.pathname === '/v1/user') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ email, userId: 'live-user' }));
        return;
      }
      const echo = {};
      if (req.method === 'POST' && req.headers['x-codemie-publication-contract']) {
        const project = req.headers['x-codemie-project'];
        echo['X-CodeMie-Publication-Contract'] = String(req.headers['x-codemie-publication-contract']);
        echo['X-CodeMie-Destination'] = project ? 'project' : 'personal';
        if (project) echo['X-CodeMie-Bound-Project'] = String(project);
      }
      // Hooks answer `{}`; OTLP answers an empty Export*ServiceResponse (no partial_success => all accepted).
      res.writeHead(200, { 'content-type': 'application/json', ...echo });
      res.end('{}');
    });
  });

  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const port = server.address().port;

  /** Flattened hook events across all event-hooks POSTs (the forwarder sends application/x-ndjson, one event per line). */
  const hookEvents = () => requests.filter((r) => r.kind === 'hooks').flatMap((r) =>
    r.body.split('\n').filter(Boolean).flatMap((line) => {
      try { return [{ ...JSON.parse(line), __arrivedAt: r.at, __seq: r.seq }]; } catch { return []; }
    }));
  /** Flattened OTLP log records forwarded to the backend. */
  const otlpLogRecords = () => requests.filter((r) => r.kind === 'otlp-logs').flatMap((r) =>
    (r.json?.resourceLogs ?? []).flatMap((rl) => (rl.scopeLogs ?? []).flatMap((sl) => (sl.logRecords ?? []).map((lr) => ({ ...lr, __arrivedAt: r.at, __seq: r.seq })))));

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    routes: ROUTES,
    requests,
    hookEvents,
    otlpLogRecords,
    byKind: (k) => requests.filter((r) => r.kind === k),
    clear: () => { requests.length = 0; },
    async waitFor(pred, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (pred(requests)) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return pred(requests);
    },
    stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}
