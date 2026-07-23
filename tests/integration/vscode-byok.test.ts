/**
 * VS Code BYOK end-to-end integration test
 * @group integration
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeVsCodeLanguageModelsConfigAtPath } from '../../src/cli/commands/proxy/connectors/vscode.js';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import { GatewayKeyPlugin } from '../../src/providers/plugins/sso/proxy/plugins/gateway-key.plugin.js';
import { HeaderInjectionPlugin } from '../../src/providers/plugins/sso/proxy/plugins/header-injection.plugin.js';
import {
  getPluginRegistry,
  resetPluginRegistry,
} from '../../src/providers/plugins/sso/proxy/plugins/registry.js';

const GATEWAY_KEY = 'test-local-key';
const PROFILE_MODEL = 'profile-selected-model';

interface StartedServer {
  server: Server;
  url: string;
}

interface CapturedRequest {
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

interface LanguageModel {
  id?: unknown;
  name?: unknown;
  url?: unknown;
}

interface LanguageModelProvider {
  name?: unknown;
  vendor?: unknown;
  models?: LanguageModel[];
}

async function listen(server: Server): Promise<StartedServer> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
}

describe('VS Code BYOK utility flow', () => {
  const proxies: CodeMieProxy[] = [];
  const servers: Server[] = [];
  let testDir: string;

  beforeEach(async () => {
    resetPluginRegistry();
    testDir = await mkdtemp(join(tmpdir(), 'codemie-vscode-byok-'));
    await mkdir(join(testDir, 'User'));
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const server of servers.splice(0)) await closeServer(server);
    await rm(testDir, { recursive: true, force: true });
    resetPluginRegistry();
  });

  it('uses the configured profile model through the authenticated local proxy', async () => {
    const captured: CapturedRequest[] = [];
    const toolResponse = {
      id: 'completion-1',
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: {
              name: 'get_test_value',
              arguments: '{"name":"vscode-byok"}',
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then((body) => {
        captured.push({ headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(toolResponse));
      });
    }));
    servers.push(upstream.server);

    const registry = getPluginRegistry();
    registry.register(new GatewayKeyPlugin());
    registry.register(new HeaderInjectionPlugin());
    const proxy = new CodeMieProxy({
      targetApiUrl: upstream.url,
      host: '127.0.0.1',
      port: 0,
      provider: 'test-provider',
      gatewayKey: GATEWAY_KEY,
      clientType: 'vscode-byok',
      project: 'test-project',
    });
    proxies.push(proxy);
    const startedProxy = await proxy.start();

    const configPath = join(testDir, 'User', 'chatLanguageModels.json');
    await writeVsCodeLanguageModelsConfigAtPath(
      configPath,
      startedProxy.url,
      PROFILE_MODEL
    );
    const providers = JSON.parse(
      await readFile(configPath, 'utf-8')
    ) as LanguageModelProvider[];
    const codeMieProvider = providers.find(
      (provider) => provider.name === 'CodeMie' && provider.vendor === 'customendpoint'
    );
    const configuredModel = codeMieProvider?.models?.find(
      (model) => model.name === 'CodeMie Profile Model'
    );

    expect(configuredModel).toMatchObject({
      id: PROFILE_MODEL,
      url: `${startedProxy.url}/v1/chat/completions`,
    });

    const requestBody = {
      model: configuredModel?.id,
      stream: false,
      messages: [{
        role: 'user',
        content: 'Call get_test_value with name "vscode-byok". Do not answer directly.',
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_test_value',
          description: 'Return a harmless synthetic test value.',
          parameters: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          strict: true,
        },
      }],
      tool_choice: 'required',
    };
    const response = await fetch(String(configuredModel?.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GATEWAY_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(toolResponse);
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual(requestBody);
    expect(captured[0].headers.authorization).toBeUndefined();
    expect(captured[0].headers['x-codemie-client']).toBe('vscode-byok');
    expect(captured[0].headers['x-codemie-project']).toBe('test-project');
  });
});
