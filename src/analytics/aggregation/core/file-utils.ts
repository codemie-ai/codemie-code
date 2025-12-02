/**
 * File Utilities for Analytics
 *
 * Provides utilities for detecting file language and format categories.
 */

import { extname } from 'node:path';

/**
 * Detect programming language from file extension
 */
export function detectLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase();

  const languageMap: Record<string, string> = {
    // TypeScript / JavaScript
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.mjs': 'javascript',
    '.cjs': 'javascript',

    // Python
    '.py': 'python',
    '.pyw': 'python',
    '.pyx': 'python',

    // Java / JVM
    '.java': 'java',
    '.kt': 'kotlin',
    '.kts': 'kotlin',
    '.scala': 'scala',
    '.groovy': 'groovy',

    // C / C++
    '.c': 'c',
    '.h': 'c',
    '.cpp': 'cpp',
    '.cc': 'cpp',
    '.cxx': 'cpp',
    '.hpp': 'cpp',
    '.hxx': 'cpp',

    // C#
    '.cs': 'csharp',
    '.csx': 'csharp',

    // Go
    '.go': 'go',

    // Rust
    '.rs': 'rust',

    // Ruby
    '.rb': 'ruby',
    '.rake': 'ruby',

    // PHP
    '.php': 'php',
    '.phtml': 'php',

    // Swift
    '.swift': 'swift',

    // Shell
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'zsh',
    '.fish': 'fish',

    // Web (Markup)
    '.html': 'html',
    '.htm': 'html',
    '.xml': 'xml',
    '.svg': 'svg',

    // Web (Styles)
    '.css': 'css',
    '.scss': 'scss',
    '.sass': 'sass',
    '.less': 'less',

    // SQL
    '.sql': 'sql',

    // Documentation / Markup
    '.md': 'markdown',
    '.mdx': 'markdown',
    '.rst': 'restructuredtext',
    '.tex': 'latex',
    '.adoc': 'asciidoc',

    // Data / Config (with language syntax)
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',

    // Other languages
    '.lua': 'lua',
    '.r': 'r',
    '.m': 'matlab',
    '.pl': 'perl',
    '.pm': 'perl',
    '.ex': 'elixir',
    '.exs': 'elixir',
    '.erl': 'erlang',
    '.hrl': 'erlang',
    '.vim': 'vimscript',
    '.lisp': 'lisp',
    '.clj': 'clojure',
    '.dart': 'dart',
    '.julia': 'julia',
    '.zig': 'zig',
    '.nim': 'nim',
  };

  return languageMap[ext];
}

/**
 * Detect file format (returns extension without dot, or special name for no-extension files)
 * Examples: "ts", "py", "md", "Dockerfile", "Makefile"
 */
export function detectFormat(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split('/').pop()?.toLowerCase() || '';

  // Files without extensions - use basename
  if (!ext) {
    // Special known files
    if (basename === 'dockerfile') return 'Dockerfile';
    if (basename === 'makefile') return 'Makefile';
    if (basename === 'rakefile') return 'Rakefile';
    if (basename === 'gemfile') return 'Gemfile';
    if (basename === 'jenkinsfile') return 'Jenkinsfile';
    if (basename.startsWith('.')) return basename; // .gitignore, .npmrc, etc.

    return 'other';
  }

  // Return extension without the leading dot
  return ext.slice(1);
}

/**
 * Count lines in a string
 * Uses split('\n').length for consistency
 */
export function countLines(content: string): number {
  if (!content) return 0;
  return content.split('\n').length;
}

/**
 * Calculate byte size of string content
 */
export function calculateByteSize(content: string): number {
  return Buffer.byteLength(content, 'utf-8');
}
