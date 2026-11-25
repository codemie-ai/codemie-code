/**
 * EPMCDME-15782 regression for the built `bin/codemie.js hook --agent claude-code-otlp`.
 * Runs against a loopback spool server and inspects the transcript cursor in a private CODEMIE_HOME.
 * Run `npm run build` before running this integration test.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { DaemonState } from '../../src/cli/commands/proxy/daemon-manager.js';
import type { OtlpHookBatchRequest } from '../../src/providers/plugins/sso/proxy/plugins/otlp.plugin.js';
import { deriveMachineEncryptionKey, deriveUrlStorageKey, encryptWithKey } from '../../src/utils/credential-crypto.js';
import { isolatedEnv, realDir } from '../helpers/isolated-cli.js';

const cli = fileURLToPath(new URL('../../bin/codemie.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
const run = promisify(execFile);
const sessionId = 'usage-delivery-retry';

function runHook(cwd: string, home: string, transcriptPath: string, hook: 'SessionStart' | 'Stop', preload?: string) {
  const nodeArgs = preload ? ['--require', preload] : [];
  const child = run(process.execPath, [...nodeArgs, cli, 'hook', '--agent', 'claude-code-otlp'], {
    cwd,
    env: {
      ...isolatedEnv(),
      HOME: home,
      USERPROFILE: home,
      CODEMIE_HOME: home,
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

/** Record the real fetch failure and the batch that caused it in this hook process. */
function observeFailedDelivery(root: string, daemonUrl: string) {
  const preload = join(root, 'observe-failed-delivery.cjs');
  const observedFile = join(root, 'failed-deliveries.jsonl');
  writeFileSync(observedFile, '');
  writeFileSync(preload, `
const { appendFileSync } = require('node:fs');
const send = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  try {
    return await send(url, options);
  } catch (error) {
    if (url === ${JSON.stringify(`${daemonUrl}/v1/analytics/hooks`)} && options?.method === 'POST') {
      const attempt = { body: options.body, code: error.cause?.code };
      appendFileSync(${JSON.stringify(observedFile)}, JSON.stringify(attempt) + '\\n');
    }
    throw error;
  }
};
`);
  return { preload, observedFile };
}

describe('Claude Code hook usage delivery retry (EPMCDME-15782)', () => {
  it('keeps unacknowledged usage after HTTP 500 and connection refusal and delivers it once on recovery', async () => {
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

    let daemon: ChildProcess | undefined;
    try {
      // The CLI can stop the process named in its daemon state. Use a disposable process for that PID.
      daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore', windowsHide: true });
      await once(daemon, 'spawn');
      const daemonPid = daemon.pid;
      if (daemonPid === undefined) throw new Error('Spool server fixture process did not start');

      const firstPort = await listen(server);
      const syncCodeMieUrl = `http://127.0.0.1:${firstPort}`;
      const writeDaemonState = (port: number) => writeFileSync(join(home, 'proxy-daemon.json'), JSON.stringify({
        pid: daemonPid,
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

      // Establish a session with an empty transcript and a persisted cursor at zero.
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

      // The spool rejects the first usage batch with HTTP 500.
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

      // With the listener gone, this Stop still attempts to send the same usage and receives ECONNREFUSED.
      await close(server);
      const { preload, observedFile } = observeFailedDelivery(root, syncCodeMieUrl);
      await runHook(cwd, home, transcriptPath, 'Stop', preload);
      const failures = readFileSync(observedFile, 'utf8').split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as { body: string; code: string });
      expect(failures).toMatchObject([{ code: 'ECONNREFUSED' }]);
      expect(usageEvents(failures[0].body)).toEqual(rejected);
      expect(readOffset()).toBe(0);

      // After recovery the spool acknowledges the same usage and the hook advances the cursor.
      status = 204;
      writeDaemonState(await listen(server));
      received.length = 0;
      await runHook(cwd, home, transcriptPath, 'Stop');
      expect(received).toHaveLength(1);
      expect(usageEvents(received[0])).toEqual(rejected);
      expect(readOffset()).toBe(Buffer.byteLength(transcript));

      // A further Stop no longer emits usage from the acknowledged transcript line.
      received.length = 0;
      await runHook(cwd, home, transcriptPath, 'Stop');
      expect(received).toHaveLength(1);
      expect(usageEvents(received[0])).toEqual([]);
      expect(readOffset()).toBe(Buffer.byteLength(transcript));
    } finally {
      try {
        if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
          const exited = once(daemon, 'exit');
          daemon.kill();
          await exited;
        }
      } finally {
        if (server.listening) await close(server);
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }, 90_000);
});
