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
