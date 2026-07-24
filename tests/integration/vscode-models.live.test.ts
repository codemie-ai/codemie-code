/**
 * Opt-in live CodeMie model certification for the VS Code catalog.
 *
 * Required:
 *   CODEMIE_VSCODE_LIVE=1
 *   CODEMIE_VSCODE_MODELS=<model-id|model-a,model-b|slice:1|all>
 *
 * Authentication:
 *   Either start a VS Code proxy with `codemie proxy connect vscode`, or set:
 *   CODEMIE_VSCODE_LIVE_URL=http://127.0.0.1:4001
 *   CODEMIE_VSCODE_LIVE_API_KEY=<local proxy key or gateway token>
 *
 * Optional:
 *   CODEMIE_VSCODE_EFFORTS=<effort|effort-a,effort-b|all>
 *   CODEMIE_VSCODE_PROJECT=<project>
 *   CODEMIE_VSCODE_REPORT_PATH=<markdown-output-path>
 *   CODEMIE_VSCODE_REQUEST_TIMEOUT_MS=<milliseconds>
 *   CODEMIE_VSCODE_MAX_ATTEMPTS=<positive integer, defaults to 2>
 *
 * `all` efforts certifies the no-effort/default request and every effort
 * advertised for each selected model.
 *
 * @group integration
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProcessAlive, readState } from '../../src/cli/commands/proxy/daemon-manager.js';
import {
  VS_CODE_SUPPORTED_MODELS,
  type VsCodeModelDefinition,
  type VsCodeReasoningEffort,
} from '../../src/cli/commands/proxy/connectors/vscode-models.js';

const LIVE_ENABLED = process.env.CODEMIE_VSCODE_LIVE === '1';
const ALL_EFFORTS: readonly VsCodeReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];
const DEFAULT_REPORT_PATH = resolve('reports/vscode-model-certification.md');

interface LiveConfiguration {
  baseUrl: string;
  apiKey: string;
  project?: string;
  source: 'environment' | 'running-vscode-proxy';
}

interface CertificationResult {
  model: string;
  apiType: VsCodeModelDefinition['apiType'];
  effort: VsCodeReasoningEffort | 'default';
  passed: boolean;
  status: number;
  toolCall: boolean;
  durationMs: number;
  attempts: number;
  detail: string;
}

function buildVsCodeAuthHeaders(
  definition: VsCodeModelDefinition,
  apiKey: string
): Record<string, string> {
  if (definition.requestHeaders?.Authorization) {
    return {
      authorization: definition.requestHeaders.Authorization.replace('${apiKey}', apiKey),
    };
  }
  if (definition.apiType === 'messages') return { 'x-api-key': apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

function getApiPath(definition: VsCodeModelDefinition): string {
  if (definition.apiType === 'responses') return '/v1/responses';
  if (definition.apiType === 'messages') return '/v1/messages';
  return '/v1/chat/completions';
}

function selectModels(selector: string): readonly VsCodeModelDefinition[] {
  if (selector === 'all') return VS_CODE_SUPPORTED_MODELS;

  const sliceMatch = /^slice:([123])$/.exec(selector);
  if (sliceMatch) {
    const slice = Number(sliceMatch[1]);
    return VS_CODE_SUPPORTED_MODELS.filter(model => model.releaseSlice === slice);
  }

  const requestedIds = selector.split(',').map(value => value.trim()).filter(Boolean);
  const selected = VS_CODE_SUPPORTED_MODELS.filter(model => requestedIds.includes(model.id));
  const selectedIds = new Set(selected.map(model => model.id));
  const unknownIds = requestedIds.filter(id => !selectedIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Unknown VS Code model IDs: ${unknownIds.join(', ')}`);
  }
  return selected;
}

function selectEfforts(
  definition: VsCodeModelDefinition,
  selector: string | undefined
): ReadonlyArray<VsCodeReasoningEffort | undefined> {
  if (!selector) return [undefined];
  if (selector === 'all') {
    return [undefined, ...(definition.supportsReasoningEffort ?? [])];
  }

  const requested = selector.split(',').map(value => value.trim()).filter(Boolean);
  const invalid = requested.filter(
    (effort): effort is string => !ALL_EFFORTS.includes(effort as VsCodeReasoningEffort)
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown reasoning efforts: ${invalid.join(', ')}`);
  }

  const efforts = requested as VsCodeReasoningEffort[];
  const supported = definition.supportsReasoningEffort ?? [];
  const unsupported = efforts.filter(effort => !supported.includes(effort));
  if (unsupported.length > 0) {
    throw new Error(
      `${definition.id} does not advertise efforts: ${unsupported.join(', ')}`
    );
  }
  return efforts;
}

function buildRequestBody(
  definition: VsCodeModelDefinition,
  effort: VsCodeReasoningEffort | undefined
): Record<string, unknown> {
  if (definition.apiType === 'responses') {
    return {
      model: definition.id,
      input: [{ role: 'user', content: 'Call get_test_value with value "ready".' }],
      tools: [{
        type: 'function',
        name: 'get_test_value',
        description: 'Return a supplied synthetic value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
      tool_choice: 'required',
      stream: true,
      ...(effort ? { reasoning: { effort } } : {}),
    };
  }

  if (definition.apiType === 'messages') {
    return {
      model: definition.id,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: 'Call get_test_value with value "ready".',
      }],
      tools: [{
        name: 'get_test_value',
        description: 'Return a supplied synthetic value.',
        input_schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      }],
      tool_choice: { type: 'auto' },
      stream: true,
      ...(definition.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(effort ? { output_config: { effort } } : {}),
    };
  }

  return {
    model: definition.id,
    messages: [{
      role: 'user',
      content: 'Call get_test_value with value "ready".',
    }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_test_value',
        description: 'Return a supplied synthetic value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    }],
    tool_choice: 'required',
    stream: true,
    ...(definition.modelOptions?.temperature === null ? {} : {
      ...(definition.modelOptions?.temperature !== undefined
        ? { temperature: definition.modelOptions.temperature }
        : {}),
    }),
    ...(definition.modelOptions?.top_p === null ? {} : {
      ...(definition.modelOptions?.top_p !== undefined
        ? { top_p: definition.modelOptions.top_p }
        : {}),
    }),
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

function parseResponsePayloads(rawBody: string): unknown[] {
  const trimmed = rawBody.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return [JSON.parse(trimmed) as unknown];
    } catch {
      return [];
    }
  }

  const payloads: unknown[] = [];
  for (const line of rawBody.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice('data:'.length).trim();
    if (!data || data === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(data) as unknown);
    } catch {
      // Ignore non-JSON SSE metadata while retaining all valid event payloads.
    }
  }
  return payloads;
}

function containsToolCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(item => containsToolCall(item));
  if (typeof value !== 'object' || value === null) return false;

  const record = value as Record<string, unknown>;
  if (record.type === 'function_call' || record.type === 'tool_use') return true;
  if (Array.isArray(record.tool_calls) && record.tool_calls.length > 0) return true;
  return Object.values(record).some(item => containsToolCall(item));
}

function findErrorMessage(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = findErrorMessage(item);
      if (message) return message;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const record = value as Record<string, unknown>;
  if (typeof record.message === 'string' && (
    record.type === 'error' ||
    record.code !== undefined ||
    record.error !== undefined
  )) {
    return record.message;
  }
  if (record.error !== undefined) {
    const nested = findErrorMessage(record.error);
    if (nested) return nested;
  }
  return undefined;
}

function compactDetail(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
    .slice(0, 500);
}

function getResponseDetail(
  responseOk: boolean,
  toolCall: boolean,
  rawBody: string,
  payloads: unknown[]
): string {
  if (responseOk && toolCall) return 'Streaming function tool call received.';
  if (responseOk) return 'Request succeeded but no function tool call was detected.';

  for (const payload of payloads) {
    const message = findErrorMessage(payload);
    if (message) return compactDetail(message);
  }
  return compactDetail(rawBody) || 'Request failed without a response body.';
}

async function resolveLiveConfiguration(): Promise<LiveConfiguration> {
  const configuredUrl = process.env.CODEMIE_VSCODE_LIVE_URL?.replace(/\/$/, '');
  const configuredKey = process.env.CODEMIE_VSCODE_LIVE_API_KEY;
  if (configuredUrl && configuredKey) {
    return {
      baseUrl: configuredUrl,
      apiKey: configuredKey,
      project: process.env.CODEMIE_VSCODE_PROJECT,
      source: 'environment',
    };
  }

  const state = await readState();
  if (!state || !isProcessAlive(state.pid)) {
    throw new Error(
      'Start `codemie proxy connect vscode`, or set CODEMIE_VSCODE_LIVE_URL and ' +
      'CODEMIE_VSCODE_LIVE_API_KEY.'
    );
  }
  if (state.clientType !== 'vscode-byok') {
    throw new Error(
      `The running proxy client is "${state.clientType ?? 'unknown'}"; ` +
      'live VS Code certification requires a vscode-byok proxy.'
    );
  }

  return {
    baseUrl: state.url.replace(/\/$/, ''),
    apiKey: state.gatewayKey,
    project: process.env.CODEMIE_VSCODE_PROJECT,
    source: 'running-vscode-proxy',
  };
}

async function certifyAttempt(
  configuration: LiveConfiguration,
  definition: VsCodeModelDefinition,
  effort: VsCodeReasoningEffort | undefined,
  timeoutMs: number,
  attempt: number
): Promise<CertificationResult> {
  const startedAt = Date.now();
  const headers: Record<string, string> = {
    ...buildVsCodeAuthHeaders(definition, configuration.apiKey),
    'content-type': 'application/json',
  };
  if (configuration.project) headers['x-codemie-project'] = configuration.project;

  try {
    const response = await fetch(`${configuration.baseUrl}${getApiPath(definition)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildRequestBody(definition, effort)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const rawBody = await response.text();
    const payloads = parseResponsePayloads(rawBody);
    const toolCall = payloads.some(payload => containsToolCall(payload));
    const passed = response.ok && toolCall;

    return {
      model: definition.id,
      apiType: definition.apiType,
      effort: effort ?? 'default',
      passed,
      status: response.status,
      toolCall,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
      detail: getResponseDetail(response.ok, toolCall, rawBody, payloads),
    };
  } catch (error) {
    return {
      model: definition.id,
      apiType: definition.apiType,
      effort: effort ?? 'default',
      passed: false,
      status: 0,
      toolCall: false,
      durationMs: Date.now() - startedAt,
      attempts: attempt,
      detail: compactDetail(error instanceof Error ? error.message : String(error)),
    };
  }
}

function isRetryable(result: CertificationResult): boolean {
  return result.status === 0 || result.status === 429 || result.status >= 500;
}

async function certifyCombination(
  configuration: LiveConfiguration,
  definition: VsCodeModelDefinition,
  effort: VsCodeReasoningEffort | undefined,
  timeoutMs: number,
  maxAttempts: number
): Promise<CertificationResult> {
  let lastResult: CertificationResult | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await certifyAttempt(
      configuration,
      definition,
      effort,
      timeoutMs,
      attempt
    );
    if (result.passed || !isRetryable(result)) return result;
    lastResult = result;
  }
  if (!lastResult) throw new Error('Certification did not execute any attempts.');
  return lastResult;
}

function renderReport(
  configuration: LiveConfiguration,
  selectedModels: readonly VsCodeModelDefinition[],
  results: readonly CertificationResult[]
): string {
  const passed = results.filter(result => result.passed).length;
  const failed = results.length - passed;
  const fullyPassingModels = selectedModels.filter(model => {
    const modelResults = results.filter(result => result.model === model.id);
    return modelResults.length > 0 && modelResults.every(result => result.passed);
  }).length;

  const lines = [
    '# VS Code Model Certification Report',
    '',
    `- Generated: ${new Date().toISOString()}`,
    `- Target: \`${configuration.baseUrl}\``,
    `- Authentication source: \`${configuration.source}\``,
    '- Flow: streamed function-tool request through the VS Code-scoped CodeMie proxy',
    `- Models: ${selectedModels.length}`,
    `- Model/effort combinations: ${results.length}`,
    `- Passing combinations: ${passed}`,
    `- Failing combinations: ${failed}`,
    `- Fully passing models: ${fullyPassingModels}/${selectedModels.length}`,
    '',
    'No API keys, tokens, request headers, or response payloads are stored in this report.',
    '',
    '## Results',
    '',
    '| Model | API | Effort | Result | HTTP | Tool call | Attempts | Duration | Detail |',
    '|---|---|---|---:|---:|---:|---:|---:|---|',
    ...results.map(result =>
      `| \`${result.model}\` | ${result.apiType} | \`${result.effort}\` | ` +
      `${result.passed ? 'PASS' : 'FAIL'} | ${result.status || 'n/a'} | ` +
      `${result.toolCall ? 'yes' : 'no'} | ${result.attempts} | ` +
      `${result.durationMs} ms | ${result.detail} |`
    ),
    '',
    '## Advertised Configuration',
    '',
    '| Model | API | Advertised efforts | VS Code model options |',
    '|---|---|---|---|',
    ...selectedModels.map(model => {
      const efforts = model.supportsReasoningEffort?.join(', ') ?? 'none';
      const modelOptions = model.modelOptions
        ? `\`${JSON.stringify(model.modelOptions)}\``
        : 'default';
      return `| \`${model.id}\` | ${model.apiType} | ${efforts} | ${modelOptions} |`;
    }),
    '',
    '## Interpretation',
    '',
    '- `default` means no explicit reasoning-effort parameter was sent.',
    '- Every advertised effort was sent using the model’s configured API body shape.',
    '- PASS requires both a successful HTTP response and a streamed function tool call.',
    '- A model should remain in the released catalog only when every advertised row passes.',
    '',
    '## Documentation',
    '',
    '- [VS Code custom endpoint model configuration](https://code.visualstudio.com/docs/agent-customization/language-models)',
    '- [OpenAI model and reasoning guidance](https://developers.openai.com/api/docs/models)',
    '- [AWS Claude Messages request parameters](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages-request-response.html)',
    '',
  ];

  return `${lines.join('\n')}\n`;
}

describe.runIf(LIVE_ENABLED)('VS Code live model certification', () => {
  it('streams tools through every requested model and reasoning effort', async () => {
    const selector = process.env.CODEMIE_VSCODE_MODELS;
    if (!selector) {
      throw new Error('CODEMIE_VSCODE_MODELS is required for live certification.');
    }

    const configuration = await resolveLiveConfiguration();
    const selectedModels = selectModels(selector);
    expect(selectedModels.length).toBeGreaterThan(0);

    const parsedTimeout = Number(process.env.CODEMIE_VSCODE_REQUEST_TIMEOUT_MS ?? '120000');
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error('CODEMIE_VSCODE_REQUEST_TIMEOUT_MS must be a positive number.');
    }
    const maxAttempts = Number(process.env.CODEMIE_VSCODE_MAX_ATTEMPTS ?? '2');
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new Error('CODEMIE_VSCODE_MAX_ATTEMPTS must be a positive integer.');
    }

    const results: CertificationResult[] = [];
    for (const definition of selectedModels) {
      const efforts = selectEfforts(definition, process.env.CODEMIE_VSCODE_EFFORTS);
      for (const effort of efforts) {
        results.push(await certifyCombination(
          configuration,
          definition,
          effort,
          parsedTimeout,
          maxAttempts
        ));
      }
    }

    const reportPath = resolve(
      process.env.CODEMIE_VSCODE_REPORT_PATH ?? DEFAULT_REPORT_PATH
    );
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      renderReport(configuration, selectedModels, results),
      'utf-8'
    );

    const failures = results.filter(result => !result.passed);
    expect(
      failures,
      `${failures.length} live certification combination(s) failed. ` +
      `See ${reportPath}.`
    ).toHaveLength(0);
  }, 3_600_000);
});
