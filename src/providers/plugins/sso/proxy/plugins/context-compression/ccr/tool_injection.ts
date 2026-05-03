export const CCR_TOOL_NAME = 'headroom_retrieve' as const;

export interface CcrToolCall {
  toolCallId: string;
  hashKey: string;
  query?: string;
}

type AnyRecord = Record<string, any>;

export function createCcrToolDefinition(provider: 'anthropic' | 'openai' = 'anthropic'): AnyRecord {
  const description =
    'Retrieve original uncompressed content that was compressed to save tokens. ' +
    'Use this when you need more data than what is shown in compressed tool results. ' +
    'The hash is provided in compression markers like [COMPRESSED id=abc123 ...].';

  const parameters: AnyRecord = {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'Hash key from the compression marker (e.g. "abc123" from id=abc123)',
      },
      query: {
        type: 'string',
        description: 'Optional search query to filter results. If provided, only relevant items are returned.',
      },
    },
    required: ['hash'],
  };

  if (provider === 'openai') {
    return {
      type: 'function',
      function: { name: CCR_TOOL_NAME, description, parameters },
    };
  }

  return {
    name: CCR_TOOL_NAME,
    description,
    input_schema: parameters,
  };
}

export function createSystemInstructions(): string {
  return (
    `\n\n---\nWhen you see markers like [COMPRESSED id=<hash> tokens_saved=N type=<t>], ` +
    `the content was compressed to save tokens. ` +
    `If you need the original, call the \`${CCR_TOOL_NAME}\` tool with the hash value. ` +
    `Only retrieve content if you actually need it for your response.`
  );
}

export function parseToolCall(response: AnyRecord, provider: 'anthropic' | 'openai'): CcrToolCall[] {
  const results: CcrToolCall[] = [];

  if (provider === 'anthropic') {
    const content = response['content'];
    if (!Array.isArray(content)) return results;
    for (const block of content) {
      if (
        block?.type === 'tool_use' &&
        block?.name === CCR_TOOL_NAME
      ) {
        const input = block.input as AnyRecord ?? {};
        results.push({
          toolCallId: String(block.id ?? ''),
          hashKey: String(input['hash'] ?? ''),
          query: input['query'] ? String(input['query']) : undefined,
        });
      }
    }
    return results;
  }

  // openai / openai-compatible
  const choices = response['choices'];
  if (!Array.isArray(choices)) return results;
  const message = choices[0]?.message as AnyRecord | undefined;
  if (!message) return results;
  const toolCalls = message['tool_calls'];
  if (!Array.isArray(toolCalls)) return results;
  for (const tc of toolCalls) {
    if (tc?.type === 'function' && tc?.function?.name === CCR_TOOL_NAME) {
      let args: AnyRecord = {};
      try { args = JSON.parse(String(tc.function.arguments ?? '{}')); } catch { /* ignore */ }
      results.push({
        toolCallId: String(tc.id ?? ''),
        hashKey: String(args['hash'] ?? ''),
        query: args['query'] ? String(args['query']) : undefined,
      });
    }
  }
  return results;
}

export function injectCcrTool(body: AnyRecord, provider: 'anthropic' | 'openai'): AnyRecord {
  const result = { ...body };
  const toolDef = createCcrToolDefinition(provider);

  // Inject tool definition
  const existing = Array.isArray(result['tools']) ? result['tools'] as AnyRecord[] : [];
  const alreadyInjected = existing.some(
    t => t?.name === CCR_TOOL_NAME || t?.function?.name === CCR_TOOL_NAME,
  );
  if (!alreadyInjected) {
    result['tools'] = [...existing, toolDef];
  }

  // Inject system instructions
  const instructions = createSystemInstructions();
  if (typeof result['system'] === 'string') {
    result['system'] = result['system'] + instructions;
  } else if (result['system'] === undefined) {
    result['system'] = instructions.trimStart();
  }

  return result;
}
