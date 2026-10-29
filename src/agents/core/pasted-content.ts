// The closing tag repeats the opening tag's attributes (`</pasted_content id="x">`), so both forms allow them.
const PASTED_CONTENT_TAG = /<\/?pasted_content(?:\s[^>]*)?>/g;

/**
 * Removes Claude's `<pasted_content>` wrapper tags and keeps the pasted text.
 * Text without the marker is returned unchanged; otherwise the result is trimmed
 * at both ends and inner whitespace is left as is.
 */
export function stripPastedContentTags(text: string): string {
  const stripped = text.replace(PASTED_CONTENT_TAG, '');
  return stripped === text ? text : stripped.trim();
}
