import { ICMMessage } from '../transforms/icm.js';
import { Tokenizer } from '../tokenizer/tiktoken.js';

export interface MessageInterceptor {
  id: string;
  matches(content: string, metadata?: Record<string, unknown>): boolean;
  transform(content: string, metadata?: Record<string, unknown>): Promise<string>;
}

function extractTextFromContent(
  content: ICMMessage['content'],
): string {
  if (typeof content === 'string') return content;
  return content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text as string)
    .join('');
}

function replaceTextInContent(
  original: ICMMessage['content'],
  replacement: string,
): ICMMessage['content'] {
  if (typeof original === 'string') return replacement;
  let remaining = replacement;
  return original.map(block => {
    if (block.type !== 'text' || block.text === undefined) return block;
    const updated = { ...block, text: remaining };
    remaining = '';
    return updated;
  });
}

async function applyInterceptorsToText(
  text: string,
  metadata: Record<string, unknown>,
  interceptors: MessageInterceptor[],
  tokenizer: Tokenizer,
  firedIds: Set<string>,
): Promise<string> {
  let current = text;

  for (const interceptor of interceptors) {
    if (firedIds.has(interceptor.id)) continue;
    if (!interceptor.matches(current, metadata)) continue;

    const tokensBefore = await tokenizer.countText(current);
    const transformed = await interceptor.transform(current, metadata);
    const tokensAfter = await tokenizer.countText(transformed);

    if (tokensAfter >= tokensBefore) continue;

    current = transformed;
    firedIds.add(interceptor.id);
  }

  return current;
}

export async function applyToMessages(
  messages: ICMMessage[],
  interceptors: MessageInterceptor[],
  tokenizer: Tokenizer,
  firedIds: Set<string> = new Set<string>(),
): Promise<ICMMessage[]> {
  if (interceptors.length === 0) return messages;

  const result: ICMMessage[] = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const text = extractTextFromContent(message.content);
      if (!text) {
        result.push(message);
        continue;
      }
      const metadata: Record<string, unknown> = { role: message.role };
      const transformed = await applyInterceptorsToText(text, metadata, interceptors, tokenizer, firedIds);
      result.push(
        transformed === text
          ? message
          : { ...message, content: replaceTextInContent(message.content, transformed) },
      );
      continue;
    }

    if (Array.isArray(message.content)) {
      const blocks = message.content as Array<{ type: string; text?: string; [key: string]: unknown }>;
      const hasToolResult = blocks.some(block => block.type === 'tool_result');

      if (!hasToolResult) {
        result.push(message);
        continue;
      }

      let changed = false;
      const updatedBlocks = await Promise.all(
        blocks.map(async block => {
          if (block.type !== 'tool_result') return block;

          const text = block.text ?? '';
          if (!text) return block;

          const metadata: Record<string, unknown> = { role: message.role, blockType: block.type };
          const transformed = await applyInterceptorsToText(text, metadata, interceptors, tokenizer, firedIds);

          if (transformed === text) return block;
          changed = true;
          return { ...block, text: transformed };
        }),
      );

      result.push(changed ? { ...message, content: updatedBlocks } : message);
      continue;
    }

    result.push(message);
  }

  return result;
}
