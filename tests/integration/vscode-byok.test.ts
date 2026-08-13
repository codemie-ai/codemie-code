/**
 * VS Code BYOK end-to-end integration tests
 * @group integration
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VS_CODE_SUPPORTED_MODELS,
  type VsCodeModelDefinition,
  type VsCodeReasoningEffort,
} from '../../src/cli/commands/proxy/connectors/vscode-models.js';
import {
  writeVsCodeLanguageModelsConfigAtPath,
} from '../../src/cli/commands/proxy/connectors/vscode.js';
import { CodeMieProxy } from '../../src/providers/plugins/sso/proxy/sso.proxy.js';
import { GatewayKeyPlugin } from '../../src/providers/plugins/sso/proxy/plugins/gateway-key.plugin.js';
import {
  HeaderInjectionPlugin,
} from '../../src/providers/plugins/sso/proxy/plugins/header-injection.plugin.js';
import {
  CodexEncryptedContentSanitizerPlugin,
} from '../../src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.js';
import {
  VsCodeRequestNormalizerPlugin,
} from '../../src/providers/plugins/sso/proxy/plugins/vscode-request-normalizer.plugin.js';
import {
  getPluginRegistry,
  resetPluginRegistry,
} from '../../src/providers/plugins/sso/proxy/plugins/registry.js';

const GATEWAY_KEY = 'test-local-key';
const PROFILE_MODEL = 'profile-selected-model-that-must-not-be-used';

interface StartedServer {
  server: Server;
  url: string;
}

interface CapturedRequest {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

interface LanguageModel {
  id: string;
  name: string;
  url: string;
  apiType: string;
  thinking?: boolean;
  zeroDataRetentionEnabled?: boolean;
  supportsReasoningEffort?: readonly string[];
  reasoningEffortFormat?: string;
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

function buildRequestBody(
  definition: VsCodeModelDefinition,
  effort: VsCodeReasoningEffort | undefined
): Record<string, unknown> {
  if (definition.apiType === 'responses') {
    return {
      model: definition.id,
      store: false,
      stream: false,
      input: [{ role: 'user', content: 'Call get_test_value.' }],
      tools: [{
        type: 'function',
        name: 'get_test_value',
        description: 'Return a synthetic test value.',
        parameters: { type: 'object', properties: {} },
        strict: true,
      }],
      tool_choice: 'required',
      ...(effort ? { reasoning: { effort } } : {}),
    };
  }

  if (definition.apiType === 'messages') {
    return {
      model: definition.id,
      max_tokens: 1024,
      stream: false,
      messages: [{ role: 'user', content: 'Call get_test_value.' }],
      tools: [{
        name: 'get_test_value',
        description: 'Return a synthetic test value.',
        input_schema: { type: 'object', properties: {} },
      }],
      tool_choice: { type: 'auto' },
      ...(definition.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
    };
  }

  return {
    model: definition.id,
    stream: false,
    messages: [{ role: 'user', content: 'Call get_test_value.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_test_value',
        description: 'Return a synthetic test value.',
        parameters: { type: 'object', properties: {} },
        strict: true,
      },
    }],
    tool_choice: 'required',
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

function buildVsCodeAuthHeaders(
  definition: VsCodeModelDefinition
): Record<string, string> {
  if (definition.requestHeaders?.Authorization) {
    return {
      authorization: definition.requestHeaders.Authorization.replace(
        '${apiKey}',
        GATEWAY_KEY
      ),
    };
  }
  if (definition.apiType === 'messages') return { 'x-api-key': GATEWAY_KEY };
  return { authorization: `Bearer ${GATEWAY_KEY}` };
}

function registerVsCodePipeline(): void {
  const registry = getPluginRegistry();
  registry.register(new GatewayKeyPlugin());
  registry.register(new HeaderInjectionPlugin());
  registry.register(new CodexEncryptedContentSanitizerPlugin());
  registry.register(new VsCodeRequestNormalizerPlugin());
}

async function startVsCodeProxy(targetApiUrl: string): Promise<{
  proxy: CodeMieProxy;
  url: string;
}> {
  registerVsCodePipeline();
  const proxy = new CodeMieProxy({
    targetApiUrl,
    host: '127.0.0.1',
    port: 0,
    provider: 'test-provider',
    gatewayKey: GATEWAY_KEY,
    clientType: 'vscode-byok',
    project: 'test-project',
  });
  const started = await proxy.start();
  return { proxy, url: started.url };
}

describe('VS Code BYOK model matrix', () => {
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

  it('forwards every selected model and supported effort without using the profile model', async () => {
    const captured: CapturedRequest[] = [];
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then((body) => {
        captured.push({
          url: req.url ?? '/',
          headers: req.headers,
          body,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    }));
    servers.push(upstream.server);

    const startedProxy = await startVsCodeProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const configPath = join(testDir, 'User', 'chatLanguageModels.json');
    await writeVsCodeLanguageModelsConfigAtPath(configPath, startedProxy.url);
    const providers = JSON.parse(
      await readFile(configPath, 'utf-8')
    ) as LanguageModelProvider[];
    const codeMieProvider = providers.find(
      provider => provider.name === 'CodeMie' && provider.vendor === 'customendpoint'
    );

    expect(codeMieProvider?.models).toHaveLength(VS_CODE_SUPPORTED_MODELS.length);
    expect(codeMieProvider?.models?.some(model => model.id === PROFILE_MODEL)).toBe(false);

    for (const definition of VS_CODE_SUPPORTED_MODELS) {
      const configuredModel = codeMieProvider?.models?.find(model => model.id === definition.id);
      expect(configuredModel).toMatchObject({
        id: definition.id,
        name: definition.id,
        apiType: definition.apiType,
      });
      if (definition.apiType === 'responses') {
        expect(configuredModel).toMatchObject({
          thinking: true,
          zeroDataRetentionEnabled: true,
          supportsReasoningEffort: definition.supportsReasoningEffort,
          reasoningEffortFormat: 'responses',
        });
      }

      const efforts: ReadonlyArray<VsCodeReasoningEffort | undefined> =
        [undefined, ...(definition.supportsReasoningEffort ?? [])];
      for (const effort of efforts) {
        const requestBody = buildRequestBody(definition, effort);
        const response = await fetch(String(configuredModel?.url), {
          method: 'POST',
          headers: {
            ...buildVsCodeAuthHeaders(definition),
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });

        const forwarded = captured.at(-1);
        expect(forwarded?.url).toBe(new URL(String(configuredModel?.url)).pathname);
        const expectedBody = definition.apiType === 'responses'
          ? { ...requestBody, user: 'vscode-byok' }
          : requestBody;
        expect(forwarded?.body).toEqual(expectedBody);
        expect(forwarded?.headers.authorization).toBeUndefined();
        expect(forwarded?.headers['x-api-key']).toBeUndefined();
        expect(forwarded?.headers['x-codemie-client']).toBe('vscode-byok');
        expect(forwarded?.headers['x-codemie-project']).toBe('test-project');
        expect(forwarded?.headers['x-codemie-cli-model']).toBeUndefined();
      }
    }
  });

  it('forwards encrypted Responses state untouched while affinity is healthy', async () => {
    const captured: CapturedRequest[] = [];
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then((body) => {
        captured.push({
          url: req.url ?? '/',
          headers: req.headers,
          body,
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    }));
    servers.push(upstream.server);

    const startedProxy = await startVsCodeProxy(upstream.url);
    proxies.push(startedProxy.proxy);
    const input = [
      { type: 'message', role: 'user', content: 'Call the test tool.' },
      {
        type: 'reasoning',
        summary: [],
        encrypted_content: 'deployment-bound-state',
      },
      {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Calling the tool.' }],
      },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'get_test_value',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'ready',
      },
    ];
    const requestBody = {
      model: 'gpt-5.6-sol-2026-07-09',
      store: false,
      stream: false,
      reasoning: { effort: 'medium' },
      include: ['reasoning.encrypted_content', 'usage'],
      input,
      tools: [{ type: 'function', name: 'get_test_value' }],
    };

    const response = await fetch(`${startedProxy.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GATEWAY_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const expectedBody = {
      ...requestBody,
      user: 'vscode-byok',
    };
    expect(captured[0]?.body).toEqual(expectedBody);
    expect(captured[0]?.body).not.toHaveProperty('previous_response_id');
    expect(captured[0]?.headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify(expectedBody), 'utf-8'))
    );
  });

  it('strips reasoning state on later requests once upstream rejects a replay', async () => {
    const captured: CapturedRequest[] = [];
    const upstream = await listen(createServer((req, res) => {
      void readRequestBody(req).then((body) => {
        captured.push({ url: req.url ?? '/', headers: req.headers, body });
        res.setHeader('content-type', 'application/json');
        // First response mimics an expired affinity pin; later ones succeed.
        if (captured.length === 1) {
          res.statusCode = 400;
          res.end(JSON.stringify({
            error: { code: 'invalid_encrypted_content', message: 'could not be verified' },
          }));
          return;
        }
        res.end(JSON.stringify({ ok: true }));
      });
    }));
    servers.push(upstream.server);

    const startedProxy = await startVsCodeProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const input = [
      { type: 'message', role: 'user', content: 'Call the test tool.' },
      { type: 'reasoning', summary: [], encrypted_content: 'deployment-bound-state' },
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'get_test_value',
        arguments: '{}',
      },
    ];
    const requestBody = {
      model: 'gpt-5.6-sol-2026-07-09',
      store: false,
      stream: false,
      reasoning: { effort: 'medium' },
      include: ['reasoning.encrypted_content', 'usage'],
      input,
      tools: [{ type: 'function', name: 'get_test_value' }],
    };
    const send = () => fetch(`${startedProxy.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${GATEWAY_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const rejected = await send();
    expect(rejected.status).toBe(400);
    // Rejection is surfaced, not swallowed: that turn fails, the session recovers.
    expect(captured[0]?.body).toMatchObject({
      include: ['reasoning.encrypted_content', 'usage'],
    });
    expect(captured[0]?.body.input).toContainEqual(
      expect.objectContaining({ type: 'reasoning' })
    );

    const recovered = await send();
    expect(recovered.status).toBe(200);

    const strippedBody = {
      ...requestBody,
      include: ['usage'],
      input: input.filter(item => item.type !== 'reasoning'),
      user: 'vscode-byok',
    };
    expect(captured[1]?.body).toEqual(strippedBody);
    expect(captured[1]?.headers['content-length']).toBe(
      String(Buffer.byteLength(JSON.stringify(strippedBody), 'utf-8'))
    );
  });
});
