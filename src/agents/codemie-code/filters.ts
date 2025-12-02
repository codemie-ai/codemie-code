/**
 * Directory and File Filtering System
 *
 * Provides intelligent filtering for directory listings to exclude common
 * directories and files that are typically gitignored or not relevant
 * for code analysis (dependencies, build artifacts, IDE files, etc.)
 */

/**
 * Filter configuration interface
 */
export interface FilterConfig {
  /** Enable/disable filtering entirely */
  enabled: boolean;

  /** Custom patterns to ignore (in addition to defaults) */
  customIgnorePatterns?: string[];

  /** Patterns to always include (overrides ignore patterns) */
  forceIncludePatterns?: string[];

  /** Enable case-sensitive matching */
  caseSensitive?: boolean;
}

/**
 * Default filter patterns organized by category
 */
export const DEFAULT_IGNORE_PATTERNS = {
  // Version Control
  versionControl: [
    '.git/**',
    '.svn/**',
    '.hg/**',
    '.bzr/**'
  ],

  // Dependencies & Package Managers
  dependencies: [
    'node_modules/**',
    'bower_components/**',
    'vendor/**',
    'packages/**',
    '.pnpm-store/**',
    '.yarn/**'
  ],

  // Build & Distribution
  buildArtifacts: [
    'dist/**',
    'build/**',
    'out/**',
    'target/**',
    '.next/**',
    '.nuxt/**',
    '.vuepress/**',
    'public/build/**',
    '.output/**'
  ],

  // Test Coverage & Reports
  testOutput: [
    'coverage/**',
    '.nyc_output/**',
    '.pytest_cache/**',
    'htmlcov/**',
    'test-results/**',
    '.coverage'
  ],

  // IDE & Editor Files
  ideFiles: [
    '.vscode/**',
    '.idea/**',
    '.eclipse/**',
    '*.swp',
    '*.swo',
    '*~',
    '.*.swp',
    '.*.swo'
  ],

  // OS Files
  osFiles: [
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '*.tmp',
    '*.temp',
    '.Trashes',
    '.fseventsd',
    '.Spotlight-V100',
    '.TemporaryItems'
  ],

  // Cache & Temporary
  cache: [
    '.cache/**',
    '.tmp/**',
    '.temp/**',
    'tmp/**',
    'temp/**',
    '.parcel-cache/**',
    '.turbo/**'
  ],

  // Language-Specific Patterns
  python: [
    '__pycache__/**',
    '*.pyc',
    '*.pyo',
    '*.pyd',
    '.Python',
    '*.so',
    '.venv/**',
    'venv/**',
    'env/**',
    '.env/**',
    'virtualenv/**',
    '.virtualenv/**',
    'myenv/**',
    '.myenv/**',
    '*venv/**',         // Matches any directory ending with 'venv'
    '.*venv/**',        // Matches any hidden directory ending with 'venv'
    'pip-log.txt',
    'pip-delete-this-directory.txt',
    '.pytest_cache/**',
    '.tox/**',
    'site-packages/**'
  ],

  java: [
    '*.class',
    '*.jar',
    '*.war',
    '*.ear',
    '.gradle/**',
    'target/**',
    '.mvn/**'
  ],

  javascript: [
    'node_modules/**',
    '.npm/**',
    '.yarn/**',
    'yarn-error.log',
    'npm-debug.log*',
    'yarn-debug.log*',
    'lerna-debug.log*'
  ],

  go: [
    'vendor/**',
    '*.exe',
    '*.test',
    '*.prof'
  ],

  rust: [
    'target/**',
    'Cargo.lock'
  ],

  cCpp: [
    '*.o',
    '*.so',
    '*.dll',
    '*.exe',
    '*.out',
    '*.a',
    '*.lib'
  ],

  ruby: [
    '.bundle/**',
    'vendor/bundle/**',
    '*.gem'
  ],

  dotnet: [
    'bin/**',
    'obj/**',
    '*.user',
    '*.suo',
    '*.sln.docstates'
  ]
};

/**
 * Compile all default patterns into a single array
 */
export function getDefaultIgnorePatterns(): string[] {
  return Object.values(DEFAULT_IGNORE_PATTERNS).flat();
}

/**
 * Simple glob pattern matcher
 * Supports * (any chars), ** (any dirs), and ? (single char)
 */
export function matchesPattern(filename: string, pattern: string, caseSensitive = false): boolean {
  if (!caseSensitive) {
    filename = filename.toLowerCase();
    pattern = pattern.toLowerCase();
  }

  // Handle simple cases first
  if (pattern === filename) return true;
  if (pattern === '*') return true;
  if (pattern === '**') return true;

  // Split pattern into parts for better handling
  const patternParts = pattern.split('/');
  const filenameParts = filename.split('/');

  // Handle directory patterns ending with **
  if (pattern.endsWith('/**')) {
    const baseParts = patternParts.slice(0, -1); // Remove the '**'

    // Match the base directory first
    if (filenameParts.length >= baseParts.length) {
      for (let i = 0; i < baseParts.length; i++) {
        if (!matchesSinglePattern(filenameParts[i], baseParts[i])) {
          return false;
        }
      }
      return true; // Base matches, ** matches the rest
    }
    return false;
  }

  // Handle exact path matching
  if (patternParts.length !== filenameParts.length) {
    return false;
  }

  // Match each part
  for (let i = 0; i < patternParts.length; i++) {
    if (!matchesSinglePattern(filenameParts[i], patternParts[i])) {
      return false;
    }
  }

  return true;
}

/**
 * Match a single pattern part (no slashes)
 */
function matchesSinglePattern(text: string, pattern: string): boolean {
  if (pattern === text) return true;
  if (pattern === '*') return true;
  if (pattern === '**') return true;

  // Convert simple glob to regex
  let regexPattern = pattern
    .replaceAll('.', '\\.')     // Escape dots
    .replaceAll('+', '\\+')     // Escape plus
    .replaceAll('^', '\\^')     // Escape caret
    .replaceAll('$', '\\$')     // Escape dollar
    .replaceAll('(', '\\(')     // Escape parentheses
    .replaceAll(')', '\\)')
    .replaceAll('[', '\\[')     // Escape brackets
    .replaceAll(']', '\\]')
    .replaceAll('{', '\\{')     // Escape braces
    .replaceAll('}', '\\}')
    .replaceAll('*', '.*')      // * matches anything
    .replaceAll('?', '.');      // ? matches single char

  try {
    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(text);
  } catch {
    return text === pattern;
  }
}

/**
 * Check if a file or directory should be ignored
 */
export function shouldIgnore(
  name: string,
  isDirectory: boolean,
  config: FilterConfig,
  relativePath?: string
): boolean {
  if (!config.enabled) {
    return false;
  }

  // Full path for matching (use name if no relative path provided)
  const fullPath = relativePath || name;
  const pathToCheck = isDirectory ? `${fullPath}/` : fullPath;

  // Check force include patterns first
  if (config.forceIncludePatterns) {
    for (const pattern of config.forceIncludePatterns) {
      if (matchesPattern(pathToCheck, pattern, config.caseSensitive)) {
        return false; // Force include overrides ignore
      }
      if (matchesPattern(name, pattern, config.caseSensitive)) {
        return false;
      }
    }
  }

  // Get all ignore patterns (default + custom)
  const ignorePatterns = [
    ...getDefaultIgnorePatterns(),
    ...(config.customIgnorePatterns || [])
  ];

  // Check ignore patterns
  for (const pattern of ignorePatterns) {
    if (matchesPattern(pathToCheck, pattern, config.caseSensitive)) {
      return true;
    }
    if (matchesPattern(name, pattern, config.caseSensitive)) {
      return true;
    }
  }

  return false;
}

/**
 * Filter an array of directory entries
 */
export function filterDirectoryEntries(
  entries: Array<{ name: string; isDirectory: boolean }>,
  config: FilterConfig,
  basePath = ''
): Array<{ name: string; isDirectory: boolean }> {
  if (!config.enabled) {
    return entries;
  }

  return entries.filter(entry => {
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    return !shouldIgnore(entry.name, entry.isDirectory, config, relativePath);
  });
}

/**
 * Default filter configuration
 */
export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  enabled: true,
  caseSensitive: false,
  customIgnorePatterns: [],
  forceIncludePatterns: []
};

/**
 * Create a filter configuration with custom settings
 */
export function createFilterConfig(overrides: Partial<FilterConfig> = {}): FilterConfig {
  return {
    ...DEFAULT_FILTER_CONFIG,
    ...overrides
  };
}

/**
 * Get statistics about filtering
 */
export interface FilterStats {
  totalEntries: number;
  filteredEntries: number;
  ignoredEntries: number;
  ignoredByCategory: Record<string, number>;
}

/**
 * Generate filtering statistics
 */
export function generateFilterStats(
  originalEntries: Array<{ name: string; isDirectory: boolean }>,
  filteredEntries: Array<{ name: string; isDirectory: boolean }>,
  config: FilterConfig
): FilterStats {
  const ignoredEntries = originalEntries.filter(entry =>
    !filteredEntries.some(filtered => filtered.name === entry.name)
  );

  const ignoredByCategory: Record<string, number> = {};

  if (config.enabled) {
    for (const [category, patterns] of Object.entries(DEFAULT_IGNORE_PATTERNS)) {
      ignoredByCategory[category] = ignoredEntries.filter(entry => {
        const pathToCheck = entry.isDirectory ? `${entry.name}/` : entry.name;
        return patterns.some(pattern =>
          matchesPattern(pathToCheck, pattern, config.caseSensitive) ||
          matchesPattern(entry.name, pattern, config.caseSensitive)
        );
      }).length;
    }
  }

  return {
    totalEntries: originalEntries.length,
    filteredEntries: filteredEntries.length,
    ignoredEntries: ignoredEntries.length,
    ignoredByCategory
  };
}