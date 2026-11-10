/**
 * Gemini message text normalisation shared by metrics and conversations processors.
 */

export type GeminiContent = string | Array<{ text?: string }>;

/**
 * User message text recorded when a prompt has no extractable text (e.g. attachment-only).
 */
export const NON_TEXT_PROMPT_PLACEHOLDER = '[non-text prompt]';

/**
 * Strip <session_context>...</session_context> blocks and trim the result.
 */
function filterSessionContext(text: string): string | null {
  const cleaned = text.replace(/<session_context>[\s\S]*?<\/session_context>/gi, '').trim();
  return cleaned || null;
}

/**
 * Extract plain text from varied content formats.
 * Returns null when the normalised text is empty.
 */
export function extractMessageText(content: unknown): string | null {
  if (typeof content === 'string') {
    return filterSessionContext(content);
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean);
    if (textParts.length > 0) {
      return filterSessionContext(textParts.join('\n'));
    }
  }
  return null;
}

/**
 * Original message text, verbatim (no <session_context> stripping or trimming).
 * Array content is reduced to its joined text parts.
 */
export function extractRawMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}
