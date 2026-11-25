/**
 * The model value guard through a real CodeMieProxy over a fake upstream on loopback: a Claude-path request with a
 * bad `model` is answered 400 in the Anthropic envelope and never reaches the upstream; valid and model-less requests
 * are forwarded unchanged; another agent's request is not the guard's business.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CodeMieProxy } from '../sso.proxy.js';
import { resetPluginRegistry } from '../plugins/registry.js';
import { registerCorePlugins } from '../plugins/index.js';

let proxy: CodeMieProxy | undefined;
let upstream: Server | undefined;
let forwardedBodies: string[];

async function start(clientType: string): Promise<string> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // Only the messages calls count: the proxy may make its own GET calls (e.g. a model catalog lookup).
      if (req.method === 'POST') forwardedBodies.push(Buffer.concat(chunks).toString('utf-8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const server = upstream;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  proxy = new CodeMieProxy({
    targetApiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    host: '127.0.0.1',
    authMethod: 'jwt',
    jwtToken: 'dummy-upstream-jwt',
    provider: 'jwt',
    clientType,
  });
  return (await proxy.start()).url;
}

async function post(url: string, body: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  resetPluginRegistry();
  registerCorePlugins();
  forwardedBodies = [];
});

afterEach(async () => {
  await proxy?.stop();
  const server = upstream;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  proxy = undefined;
  upstream = undefined;
  resetPluginRegistry();
});

describe('the model value guard in the proxy', () => {
  it('answers a codemie-claude request with a 7,500-character model 400 and never calls the upstream', async () => {
    const url = await start('codemie-claude');
    const model = `claude-sonnet-4-5${'z'.repeat(7500)}`;

    const { status, text } = await post(url, JSON.stringify({ model, messages: [] }));

    expect(status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Invalid model value: longer than 256 characters. Received length: 7517.',
      },
    });
    expect(text).not.toContain('claude-s');
    expect(forwardedBodies).toEqual([]);
  });

  it('forwards a codemie-claude request with a valid model and one without a model', async () => {
    const url = await start('codemie-claude');
    const valid = JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] });
    const modelless = JSON.stringify({ messages: [] });

    expect((await post(url, valid)).status).toBe(200);
    expect((await post(url, modelless)).status).toBe(200);

    expect(forwardedBodies.map((body) => JSON.parse(body))).toEqual([
      JSON.parse(valid),
      JSON.parse(modelless),
    ]);
  });

  it('does not reject the same bad model from codemie-codex, which is not a Claude-path client', async () => {
    const url = await start('codemie-codex');
    const body = JSON.stringify({ model: 'bad model', messages: [] });

    const { status } = await post(url, body);

    expect(status).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(JSON.parse(forwardedBodies[0]).model).toBe('bad model');
  });
});
