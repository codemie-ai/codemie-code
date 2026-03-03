/**
 * Repository Utilities
 *
 * Shared helpers for extracting repository metadata from the working directory.
 */

/**
 * Extract repository name from working directory path.
 * Returns "parent/current" format.
 *
 * @example
 * extractRepository('/Users/john/projects/codemie-code') → 'projects/codemie-code'
 * extractRepository('C:\\Users\\john\\projects\\codemie-code') → 'projects\\codemie-code'
 */
export function extractRepository(workingDirectory: string): string {
  const parts = workingDirectory.split(/[/\\]/);
  const filtered = parts.filter(p => p.length > 0);

  if (filtered.length >= 2) {
    return `${filtered[filtered.length - 2]}/${filtered[filtered.length - 1]}`;
  }

  return filtered[filtered.length - 1] || 'unknown';
}
