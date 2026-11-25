import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import type { DaemonState } from '../../src/cli/commands/proxy/daemon-manager.js';
import type { OtlpHookBatchRequest } from '../../src/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { deriveMachineEncryptionKey, deriveUrlStorageKey, encryptWithKey } from '../../src/utils/credential-crypto.js';
import { isolatedEnv, realDir } from '../helpers/isolated-cli.js';

const cli = fileURLToPath(new URL('../../bin/codemie.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const run = promisify(execFile);
const sessionId = 'usage-delivery-retry';

function runHook(cwd: string, home: string, transcriptPath: string, hook: 'SessionStart' | 'Stop') {
  const child = run(process.execPath, [cli, 'hook', '--agent', 'claude-code-otlp'], {
    cwd,
    env: {
      ...isolatedEnv(),
      HOME: home,
      USERPROFILE: home,
      CODEMIE_HOME: home,
      CODEMIE_DEBUG: '1',
    },
    timeout: 15_000,
    windowsHide: true,
  });
  child.child.stdin?.end(JSON.stringify({
    hook_event_name: hook,
    session_id: sessionId,
    transcript_path: transcriptPath,
    cwd,
    ...(hook === 'SessionStart' ? { source: 'startup' } : { stop_hook_active: false }),
  }));
  return child;
}

async function listen(server: Server): Promise<number> {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return (server.address() as AddressInfo).port;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function usageEvents(body: string): Record<string, unknown>[] {
  const batch = JSON.parse(body) as OtlpHookBatchRequest;
  expect(batch.agentName).toBe('claude-code-otlp');
  return batch.hookEvents.filter(event => event['type'] === 'agent.usage.request');
}

it('retries Claude Code usage after HTTP 500 and connection refusal (EPMCDME-15782)', async () => {
  const root = realDir(mkdtempSync(join(tmpdir(), 'codemie-usage-retry-')));
  const home = realDir(join(root, 'home'));
  const cwd = realDir(join(root, 'workspace'));
  const transcriptPath = join(root, 'transcript.jsonl');
  const parseStatePath = join(home, 'analytics', 'state', `${sessionId}.json`);
  const readOffset = (): number => (JSON.parse(readFileSync(parseStatePath, 'utf8')) as { mainOffset: number }).mainOffset;

  let status = 204;
  const received: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/analytics/hooks') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8').on('data', chunk => { body += chunk; });
    request.on('end', () => {
      received.push(body);
      response.writeHead(status).end();
    });
  });

  try {
    const firstPort = await listen(server);
    const syncCodeMieUrl = `http://127.0.0.1:${firstPort}`;
    const writeDaemonState = (port: number) => writeFileSync(join(home, 'proxy-daemon.json'), JSON.stringify({
      pid: process.pid,
      port,
      url: `http://127.0.0.1:${port}`,
      profile: 'usage-retry-test',
      gatewayKey: 'usage-retry-test-key',
      syncCodeMieUrl,
      version,
      startedAt: new Date().toISOString(),
    } satisfies DaemonState));

    // A synthetic owner claim lets the real evidence path run without signing in or contacting a backend.
    const claims = Buffer.from(JSON.stringify({ email: 'usage-retry@example.invalid' })).toString('base64url');
    const credentials = JSON.stringify({
      apiUrl: `${syncCodeMieUrl}/code-assistant-api`,
      cookies: { codemie_access_token: `test.${claims}.test` },
    });
    writeFileSync(join(realDir(join(home, 'credentials')), `${deriveUrlStorageKey(syncCodeMieUrl)}.enc`),
      encryptWithKey(credentials, deriveMachineEncryptionKey()));
    writeFileSync(join(realDir(join(home, 'cache')), 'claude-code-client-version.json'),
      JSON.stringify({ version: '2.1.330', resolvedAt: Date.now() }));

    writeDaemonState(firstPort);
    writeFileSync(transcriptPath, '');
    await runHook(cwd, home, transcriptPath, 'SessionStart');
    expect(received).toHaveLength(1);
    expect(readOffset()).toBe(0);

    const transcript = JSON.stringify({
      type: 'assistant',
      timestamp: new Date().toISOString(),
      uuid: 'usage-retry-line',
      requestId: 'usage-retry-request',
      message: {
        id: 'usage-retry-message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    }) + '\n';
    writeFileSync(transcriptPath, transcript);

    status = 500;
    received.length = 0;
    await runHook(cwd, home, transcriptPath, 'Stop');
    expect(received).toHaveLength(1);
    const rejected = usageEvents(received[0]);
    expect(rejected).toMatchObject([{
      session_id: sessionId,
      input_tokens: 100,
      output_tokens: 50,
      event_id: expect.stringMatching(/\S/),
    }]);
    expect(readOffset()).toBe(0);

    // Leave the daemon state on disk while its port is closed, as when the listener goes away.
    await close(server);
    await runHook(cwd, home, transcriptPath, 'Stop');
    const logsDir = join(home, 'logs');
    const logs = readdirSync(logsDir).map(file => readFileSync(join(logsDir, file), 'utf8')).join('\n');
    expect(logs).toContain('forwardOtlpEventsToSpool: fetch failed');
    expect(readOffset()).toBe(0);

    status = 204;
    writeDaemonState(await listen(server));
    received.length = 0;
    await runHook(cwd, home, transcriptPath, 'Stop');
    expect(received).toHaveLength(1);
    expect(usageEvents(received[0])).toEqual(rejected);
    expect(readOffset()).toBe(Buffer.byteLength(transcript));

    received.length = 0;
    await runHook(cwd, home, transcriptPath, 'Stop');
    expect(received).toHaveLength(1);
    expect(usageEvents(received[0])).toEqual([]);
    expect(readOffset()).toBe(Buffer.byteLength(transcript));
  } finally {
    if (server.listening) await close(server);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 90_000);
