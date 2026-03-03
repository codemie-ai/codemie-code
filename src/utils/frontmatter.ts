import { parse as parseYaml } from 'yaml';

/**
 * Result of parsing frontmatter from a markdown file
 */
export interface FrontmatterResult<T = Record<string, unknown>> {
  /** Parsed metadata from YAML frontmatter */
  metadata: T;

  /** Markdown content (body after frontmatter) */
  content: string;
}

/**
 * Error thrown when frontmatter parsing fails
 */
export class FrontmatterParseError extends Error {
  constructor(
    message: string,
    public readonly filePath?: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'FrontmatterParseError';
  }
}

/**
 * Parse YAML frontmatter from a markdown file
 *
 * Expected format:
 * ```
 * ---
 * key: value
 * ---
 * Content here
 * ```
 *
 * @param fileContent - Raw file content
 * @param filePath - Optional file path (for error messages)
 * @returns Parsed frontmatter metadata and markdown content
 * @throws FrontmatterParseError if parsing fails
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  fileContent: string,
  filePath?: string
): FrontmatterResult<T> {
  // Trim leading/trailing whitespace
  const trimmed = fileContent.trim();

  // Check if file starts with frontmatter delimiter
  if (!trimmed.startsWith('---')) {
    throw new FrontmatterParseError(
      'File must start with frontmatter delimiter (---)',
      filePath
    );
  }

  // Find the closing delimiter
  const lines = trimmed.split('\n');
  let closingDelimiterIndex = -1;

  // Start from line 1 (skip opening ---)
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closingDelimiterIndex = i;
      break;
    }
  }

  if (closingDelimiterIndex === -1) {
    throw new FrontmatterParseError(
      'Missing closing frontmatter delimiter (---)',
      filePath
    );
  }

  // Extract YAML content (between delimiters)
  const yamlLines = lines.slice(1, closingDelimiterIndex);
  const yamlContent = yamlLines.join('\n');

  // Extract markdown content (after closing delimiter)
  const contentLines = lines.slice(closingDelimiterIndex + 1);
  const content = contentLines.join('\n').trim();

  // Parse YAML
  let metadata: T;
  try {
    const parsed = parseYaml(yamlContent);

    // Ensure we got an object
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Frontmatter must be a YAML object (key-value pairs)');
    }

    metadata = parsed as T;
  } catch (error) {
    throw new FrontmatterParseError(
      `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
      error
    );
  }

  return {
    metadata,
    content,
  };
}

/**
 * Check if a file has valid frontmatter format (non-throwing)
 *
 * @param fileContent - Raw file content
 * @returns true if file has valid frontmatter structure
 */
export function hasFrontmatter(fileContent: string): boolean {
  try {
    parseFrontmatter(fileContent);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract just the metadata without validating content
 *
 * @param fileContent - Raw file content
 * @param filePath - Optional file path (for error messages)
 * @returns Parsed metadata
 * @throws FrontmatterParseError if parsing fails
 */
export function extractMetadata<T = Record<string, unknown>>(
  fileContent: string,
  filePath?: string
): T {
  const result = parseFrontmatter<T>(fileContent, filePath);
  return result.metadata;
}

/**
 * Extract just the content without validating metadata
 *
 * @param fileContent - Raw file content
 * @param filePath - Optional file path (for error messages)
 * @returns Markdown content
 * @throws FrontmatterParseError if parsing fails
 */
export function extractContent(fileContent: string, filePath?: string): string {
  const result = parseFrontmatter(fileContent, filePath);
  return result.content;
}
