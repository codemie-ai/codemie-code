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
 * Detect file format category
 */
export function detectFormat(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const basename = filePath.split('/').pop()?.toLowerCase() || '';

  // Test files (check first, as they may have code extensions)
  if (
    basename.includes('.test.') ||
    basename.includes('.spec.') ||
    basename.includes('_test.') ||
    basename.includes('_spec.') ||
    filePath.includes('/tests/') ||
    filePath.includes('/test/') ||
    filePath.includes('/__tests__/') ||
    filePath.includes('/spec/')
  ) {
    return 'test';
  }

  // Documentation
  const docExtensions = ['.md', '.mdx', '.rst', '.txt', '.adoc', '.tex'];
  if (docExtensions.includes(ext)) {
    return 'docs';
  }

  // Configuration files
  const configExtensions = [
    '.json', '.yaml', '.yml', '.toml', '.ini', '.conf',
    '.xml', '.properties', '.env', '.config'
  ];
  const configFiles = [
    'dockerfile', 'makefile', 'rakefile', 'gemfile',
    'package.json', 'tsconfig.json', 'jsconfig.json',
    'webpack.config', 'rollup.config', 'vite.config',
    '.eslintrc', '.prettierrc', '.babelrc', '.npmrc',
    '.gitignore', '.dockerignore', '.editorconfig'
  ];

  if (
    configExtensions.includes(ext) ||
    configFiles.some(cfg => basename.includes(cfg))
  ) {
    return 'config';
  }

  // Data files
  const dataExtensions = [
    '.csv', '.tsv', '.parquet', '.avro',
    '.db', '.sqlite', '.sql',
    '.proto', '.thrift'
  ];
  if (dataExtensions.includes(ext)) {
    return 'data';
  }

  // Build/CI files
  if (
    filePath.includes('.github/workflows/') ||
    filePath.includes('.gitlab-ci') ||
    basename.includes('jenkinsfile') ||
    basename.includes('.travis.yml') ||
    basename.includes('circle.yml')
  ) {
    return 'ci';
  }

  // Code files (programming languages)
  const codeExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.pyw', '.java', '.kt', '.scala',
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx',
    '.cs', '.go', '.rs', '.rb', '.php', '.swift',
    '.sh', '.bash', '.lua', '.r', '.pl', '.ex',
    '.erl', '.vim', '.lisp', '.clj', '.dart',
    '.julia', '.zig', '.nim', '.m'
  ];
  if (codeExtensions.includes(ext)) {
    return 'code';
  }

  // Web assets (styles, markup)
  const webExtensions = [
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.svg'
  ];
  if (webExtensions.includes(ext)) {
    return 'web';
  }

  // Assets (images, fonts, etc.)
  const assetExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm'
  ];
  if (assetExtensions.includes(ext)) {
    return 'asset';
  }

  // License files
  if (basename.includes('license') || basename.includes('copying')) {
    return 'legal';
  }

  // Default to 'other'
  return 'other';
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
