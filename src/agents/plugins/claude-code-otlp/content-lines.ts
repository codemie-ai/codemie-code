/** Lines in a file body; a trailing newline does not start another line. */
export function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}
