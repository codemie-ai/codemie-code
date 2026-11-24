/**
 * File Operations Utilities
 *
 * Common utilities for file analysis and metadata extraction.
 */

/**
 * Extract file format from path
 *
 * @param path - File path
 * @returns File extension without dot (e.g., 'ts', 'py'), or undefined if no extension
 */
export function extractFormat(path: string): string | undefined {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1 || lastDot === path.length - 1) return undefined;
  return path.slice(lastDot + 1);
}

/**
 * Detect programming language from file extension
 *
 * @param path - File path
 * @returns Language name (e.g., 'typescript', 'python'), or undefined if unknown
 */
export function detectLanguage(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const langMap: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.py': 'python',
    '.java': 'java',
    '.go': 'go',
    '.rs': 'rust',
    '.cpp': 'cpp',
    '.c': 'c',
    '.rb': 'ruby',
    '.php': 'php',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.md': 'markdown',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml'
  };
  return langMap[ext];
}

/** Lines in a file body; a trailing newline does not start another line. */
export function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}
