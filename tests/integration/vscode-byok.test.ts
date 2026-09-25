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
  VS_CODE_CAPABILITY_TABLE,
  type VsCodeCapabilityEntry,
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
  definition: VsCodeCapabilityEntry,
  effort: VsCodeReasoningEffort | undefined
): Record<string, unknown> {
  if (definition.apiType === 'responses') {
    return {
      model: definition.family,
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
      model: definition.family,
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
    model: definition.family,
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
  definition: VsCodeCapabilityEntry
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

interface VsCodeByokHarness {
  proxies: CodeMieProxy[];
  servers: Server[];
  testDir: () => string;
}

/**
 * Registers the shared per-test lifecycle (fresh plugin registry, a scratch
 * `User/` dir, and teardown of every proxy/server/tmpdir a test pushed onto
 * the returned arrays) so each `describe` block below only states what's
 * specific to it.
 */
function useVsCodeByokHarness(tmpPrefix: string): VsCodeByokHarness {
  const proxies: CodeMieProxy[] = [];
  const servers: Server[] = [];
  let testDir = '';

  beforeEach(async () => {
    resetPluginRegistry();
    testDir = await mkdtemp(join(tmpdir(), tmpPrefix));
    await mkdir(join(testDir, 'User'));
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const server of servers.splice(0)) await closeServer(server);
    await rm(testDir, { recursive: true, force: true });
    resetPluginRegistry();
  });

  return { proxies, servers, testDir: () => testDir };
}

describe('VS Code BYOK model matrix', () => {
  const { proxies, servers, testDir } = useVsCodeByokHarness('codemie-vscode-byok-');

  it('forwards every selected model and supported effort without using the profile model', async () => {
    const captured: CapturedRequest[] = [];
    const upstream = await listen(createServer((req, res) => {
      // The connector discovers the tenant catalog before writing the config;
      // serve it directly from every family in the capability table so each
      // entry resolves as an exact match — the model matrix below then
      // exercises the request-forwarding behavior, not the resolver itself.
      if (req.url?.startsWith('/v1/llm_models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          data: VS_CODE_CAPABILITY_TABLE.map(entry => ({ id: entry.family })),
        }));
        return;
      }
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

    const configPath = join(testDir(), 'User', 'chatLanguageModels.json');
    await writeVsCodeLanguageModelsConfigAtPath(configPath, startedProxy.url, GATEWAY_KEY);
    const providers = JSON.parse(
      await readFile(configPath, 'utf-8')
    ) as LanguageModelProvider[];
    const codeMieProvider = providers.find(
      provider => provider.name === 'CodeMie' && provider.vendor === 'customendpoint'
    );

    expect(codeMieProvider?.models).toHaveLength(VS_CODE_CAPABILITY_TABLE.length);
    expect(codeMieProvider?.models?.some(model => model.id === PROFILE_MODEL)).toBe(false);

    for (const definition of VS_CODE_CAPABILITY_TABLE) {
      const configuredModel = codeMieProvider?.models?.find(model => model.id === definition.family);
      expect(configuredModel).toMatchObject({
        id: definition.family,
        name: definition.family,
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

// changing the default model in CodeMie Setup must never
// narrow the VS Code model selector down to that one model. `resolveManagedModels`
// treats `profileModel` as a pin — see vscode.ts's `resolveManagedModels` — which
// currently returns a single-element array whenever a profile model resolves
// against the tenant catalog, instead of leaving the full intersected list
// in place and only marking the profile's model as the default.
//
// Both tests below use `it.fails` on purpose: the fix has not landed yet, so
// the assertions correctly throw today. `it.fails` inverts that — the suite
// stays green while the bug is open — and it will itself start failing the
// moment `resolveManagedModels` stops narrowing the list, which is the cue to
// drop `.fails` and let these run as plain regression tests.
describe('VS Code BYOK model list consistency across default-model changes', () => {
  const { proxies, servers, testDir } = useVsCodeByokHarness('codemie-vscode-model-consistency-');

  it.fails('keeps every model visible after changing the default model in CodeMie Setup', async () => {
    // Every id here resolves 1:1 against VS_CODE_CAPABILITY_TABLE (verified
    // against `resolveTenantModelId` directly) — no family aliases to a
    // shared tenant id, so the expected count below is unambiguous.
    const tenantCatalog = [
      { id: 'claude-sonnet-5' },  // Sonnet 5
      { id: 'gpt-5.6-sol' },      // GPT-6 Sol
      { id: 'gpt-5.4' },
      { id: 'claude-opus-5' },    // newly added model
    ];

    const upstream = await listen(createServer((req, res) => {
      if (req.url?.startsWith('/v1/llm_models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: tenantCatalog }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }));
    servers.push(upstream.server);

    const startedProxy = await startVsCodeProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const configPath = join(testDir(), 'User', 'chatLanguageModels.json');
    const readModelIds = async (): Promise<string[]> => {
      const providers = JSON.parse(
        await readFile(configPath, 'utf-8')
      ) as LanguageModelProvider[];
      const codeMieProvider = providers.find(
        provider => provider.name === 'CodeMie' && provider.vendor === 'customendpoint'
      );
      return (codeMieProvider?.models ?? []).map(model => model.id).sort();
    };
    const expectedModelIds = tenantCatalog.map(entry => entry.id).sort();

    // Initial setup: no default model selected yet, so every tenant model shows up.
    await writeVsCodeLanguageModelsConfigAtPath(configPath, startedProxy.url, GATEWAY_KEY, undefined);
    expect(await readModelIds()).toEqual(expectedModelIds);

    // Select Sonnet 5 as the default model in CodeMie Setup.
    await writeVsCodeLanguageModelsConfigAtPath(
      configPath, startedProxy.url, GATEWAY_KEY, 'claude-sonnet-5'
    );
    expect(await readModelIds()).toEqual(expectedModelIds);

    // Switch the default model to GPT-6 Sol: the full list must still be intact,
    // including models that were never selected as the default (claude-opus-5).
    await writeVsCodeLanguageModelsConfigAtPath(
      configPath, startedProxy.url, GATEWAY_KEY, 'gpt-5.6-sol'
    );
    expect(await readModelIds()).toEqual(expectedModelIds);
  });

  it.fails('does not shrink the model list on repeated writes as the default model changes', async () => {
    // Verified against `resolveTenantModelId` directly: these four ids each
    // resolve to exactly themselves, with no other capability-table family
    // aliasing onto the same tenant id (unlike e.g. `claude-sonnet-4-5` /
    // `claude-4-5-sonnet`, which collide) — so the expected count is exactly
    // `tenantCatalog.length`, independent of whatever a given write returns.
    const tenantCatalog = [
      { id: 'gpt-4.1' },
      { id: 'gpt-5' },
      { id: 'gemini-3-flash' },
      { id: 'claude-opus-5' },
    ];

    const upstream = await listen(createServer((req, res) => {
      if (req.url?.startsWith('/v1/llm_models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: tenantCatalog }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    }));
    servers.push(upstream.server);

    const startedProxy = await startVsCodeProxy(upstream.url);
    proxies.push(startedProxy.proxy);

    const configPath = join(testDir(), 'User', 'chatLanguageModels.json');
    const profileModels = [undefined, 'gpt-4.1', 'gpt-5', 'gpt-4.1', undefined];

    for (const profileModel of profileModels) {
      await writeVsCodeLanguageModelsConfigAtPath(configPath, startedProxy.url, GATEWAY_KEY, profileModel);

      const providers = JSON.parse(
        await readFile(configPath, 'utf-8')
      ) as LanguageModelProvider[];
      const codeMieProvider = providers.find(
        provider => provider.name === 'CodeMie' && provider.vendor === 'customendpoint'
      );
      const modelIds = (codeMieProvider?.models ?? []).map(model => model.id);

      // The bug narrows this to a single model as soon as profileModel resolves
      // against the tenant catalog.
      expect(modelIds).toHaveLength(tenantCatalog.length);
      modelIds.forEach(id => expect(tenantCatalog.some(model => model.id === id)).toBe(true));
    }
  });
});
