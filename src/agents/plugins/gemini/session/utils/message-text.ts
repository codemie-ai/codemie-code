/**
 * Gemini message text normalisation shared by metrics and conversations processors.
 */

export type GeminiContent = string | Array<{ text?: string }>;

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
