/**
 * Opt-in live CodeMie model certification for the VS Code catalog.
 *
 * Required:
 *   CODEMIE_VSCODE_LIVE=1
 *   CODEMIE_VSCODE_LIVE_URL=http://127.0.0.1:4001
 *   CODEMIE_VSCODE_LIVE_API_KEY=<local proxy key or gateway token>
 *   CODEMIE_VSCODE_MODELS=<model-id|model-a,model-b|slice:1|all>
 *
 * Optional:
 *   CODEMIE_VSCODE_EFFORTS=<effort|effort-a,effort-b|all>
 *   CODEMIE_VSCODE_PROJECT=<project>
 *
 * @group integration
 */

import { describe, expect, it } from 'vitest';
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
  if (selector === 'all') return definition.supportsReasoningEffort ?? [undefined];

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
      tool_choice: { type: 'any' },
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
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

function hasToolCall(apiType: VsCodeModelDefinition['apiType'], body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const response = body as Record<string, unknown>;

  if (apiType === 'responses') {
    return Array.isArray(response.output) &&
      response.output.some(item =>
        typeof item === 'object' && item !== null &&
        (item as Record<string, unknown>).type === 'function_call'
      );
  }

  if (apiType === 'messages') {
    return Array.isArray(response.content) &&
      response.content.some(item =>
        typeof item === 'object' && item !== null &&
        (item as Record<string, unknown>).type === 'tool_use'
      );
  }

  if (!Array.isArray(response.choices)) return false;
  return response.choices.some(choice => {
    if (typeof choice !== 'object' || choice === null) return false;
    const message = (choice as Record<string, unknown>).message;
    return typeof message === 'object' && message !== null &&
      Array.isArray((message as Record<string, unknown>).tool_calls);
  });
}

describe.runIf(LIVE_ENABLED)('VS Code live model certification', () => {
  it('accepts tools and every requested reasoning effort', async () => {
    const baseUrl = process.env.CODEMIE_VSCODE_LIVE_URL?.replace(/\/$/, '');
    const apiKey = process.env.CODEMIE_VSCODE_LIVE_API_KEY;
    const selector = process.env.CODEMIE_VSCODE_MODELS;
    if (!baseUrl || !apiKey || !selector) {
      throw new Error(
        'CODEMIE_VSCODE_LIVE_URL, CODEMIE_VSCODE_LIVE_API_KEY, and ' +
        'CODEMIE_VSCODE_MODELS are required for live certification.'
      );
    }

    const models = selectModels(selector);
    expect(models.length).toBeGreaterThan(0);

    for (const definition of models) {
      const efforts = selectEfforts(definition, process.env.CODEMIE_VSCODE_EFFORTS);
      for (const effort of efforts) {
        const headers: Record<string, string> = {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        };
        const project = process.env.CODEMIE_VSCODE_PROJECT;
        if (project) headers['x-codemie-project'] = project;

        const response = await fetch(`${baseUrl}${getApiPath(definition)}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildRequestBody(definition, effort)),
        });
        const rawBody = await response.text();

        expect(
          response.ok,
          `${definition.id} (${effort ?? 'default'}) returned ${response.status}: ` +
          rawBody.slice(0, 1000)
        ).toBe(true);

        const responseBody = JSON.parse(rawBody) as unknown;
        expect(
          hasToolCall(definition.apiType, responseBody),
          `${definition.id} (${effort ?? 'default'}) returned no function tool call`
        ).toBe(true);
      }
    }
  }, 1_800_000);
});
