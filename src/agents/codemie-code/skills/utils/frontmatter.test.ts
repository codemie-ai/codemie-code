/**
 * Tests for frontmatter parsing utilities
 */

import { describe, it, expect } from 'vitest';
import {
  parseFrontmatter,
  hasFrontmatter,
  extractMetadata,
  extractContent,
  FrontmatterParseError,
} from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('should parse valid frontmatter with content', () => {
    const fileContent = `---
name: test-skill
description: A test skill
version: 1.0.0
---
# Test Skill

This is the skill content.`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata).toEqual({
      name: 'test-skill',
      description: 'A test skill',
      version: '1.0.0',
    });
    expect(result.content).toBe('# Test Skill\n\nThis is the skill content.');
  });

  it('should parse frontmatter with nested objects', () => {
    const fileContent = `---
name: advanced-skill
description: Advanced skill
compatibility:
  agents:
    - codemie-code
    - claude
  minVersion: 1.0.0
modes:
  - code
  - architect
---
Content here`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata).toEqual({
      name: 'advanced-skill',
      description: 'Advanced skill',
      compatibility: {
        agents: ['codemie-code', 'claude'],
        minVersion: '1.0.0',
      },
      modes: ['code', 'architect'],
    });
    expect(result.content).toBe('Content here');
  });

  it('should parse frontmatter with empty content', () => {
    const fileContent = `---
name: minimal-skill
description: Minimal skill
---`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata).toEqual({
      name: 'minimal-skill',
      description: 'Minimal skill',
    });
    expect(result.content).toBe('');
  });

  it('should trim leading/trailing whitespace', () => {
    const fileContent = `
---
name: test-skill
description: Test
---
Content
  `;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata.name).toBe('test-skill');
    expect(result.content).toBe('Content');
  });

  it('should handle multiline YAML values', () => {
    const fileContent = `---
name: multiline-skill
description: |
  This is a multiline
  description with
  multiple lines
---
Content`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata.description).toBe(
      'This is a multiline\ndescription with\nmultiple lines\n'
    );
  });

  it('should throw error when missing opening delimiter', () => {
    const fileContent = `name: test-skill
description: Test
---
Content`;

    expect(() => parseFrontmatter(fileContent)).toThrow(FrontmatterParseError);
    expect(() => parseFrontmatter(fileContent)).toThrow(
      'File must start with frontmatter delimiter (---)'
    );
  });

  it('should throw error when missing closing delimiter', () => {
    const fileContent = `---
name: test-skill
description: Test
Content without closing delimiter`;

    expect(() => parseFrontmatter(fileContent)).toThrow(FrontmatterParseError);
    expect(() => parseFrontmatter(fileContent)).toThrow(
      'Missing closing frontmatter delimiter (---)'
    );
  });

  it('should throw error for invalid YAML', () => {
    const fileContent = `---
name: test-skill
description: [invalid: yaml: structure
---
Content`;

    expect(() => parseFrontmatter(fileContent)).toThrow(FrontmatterParseError);
    expect(() => parseFrontmatter(fileContent)).toThrow(
      /Failed to parse YAML frontmatter/
    );
  });

  it('should throw error when YAML is not an object', () => {
    const fileContent = `---
- item1
- item2
---
Content`;

    expect(() => parseFrontmatter(fileContent)).toThrow(FrontmatterParseError);
    expect(() => parseFrontmatter(fileContent)).toThrow(
      'Frontmatter must be a YAML object (key-value pairs)'
    );
  });

  it('should include file path in error messages', () => {
    const fileContent = `Invalid content`;
    const filePath = '/test/path/SKILL.md';

    try {
      parseFrontmatter(fileContent, filePath);
      expect.fail('Should have thrown error');
    } catch (error) {
      expect(error).toBeInstanceOf(FrontmatterParseError);
      const parseError = error as FrontmatterParseError;
      expect(parseError.filePath).toBe(filePath);
    }
  });

  it('should handle YAML with special characters', () => {
    const fileContent = `---
name: "skill-with-dash"
description: 'Single quotes: OK'
author: "John O'Brien"
---
Content`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata).toEqual({
      name: 'skill-with-dash',
      description: 'Single quotes: OK',
      author: "John O'Brien",
    });
  });

  it('should parse frontmatter with numeric and boolean values', () => {
    const fileContent = `---
name: test-skill
priority: 42
enabled: true
experimental: false
version: 1.0
---
Content`;

    const result = parseFrontmatter(fileContent);

    expect(result.metadata).toEqual({
      name: 'test-skill',
      priority: 42,
      enabled: true,
      experimental: false,
      version: 1.0,
    });
  });
});

describe('hasFrontmatter', () => {
  it('should return true for valid frontmatter', () => {
    const fileContent = `---
name: test-skill
---
Content`;

    expect(hasFrontmatter(fileContent)).toBe(true);
  });

  it('should return false for invalid frontmatter', () => {
    const fileContent = `No frontmatter here`;

    expect(hasFrontmatter(fileContent)).toBe(false);
  });

  it('should return false for missing closing delimiter', () => {
    const fileContent = `---
name: test-skill
Content`;

    expect(hasFrontmatter(fileContent)).toBe(false);
  });

  it('should return false for invalid YAML', () => {
    const fileContent = `---
[invalid: yaml
---
Content`;

    expect(hasFrontmatter(fileContent)).toBe(false);
  });
});

describe('extractMetadata', () => {
  it('should extract metadata without content', () => {
    const fileContent = `---
name: test-skill
description: Test skill
---
This content is ignored`;

    const metadata = extractMetadata(fileContent);

    expect(metadata).toEqual({
      name: 'test-skill',
      description: 'Test skill',
    });
  });

  it('should throw error for invalid frontmatter', () => {
    const fileContent = `Invalid content`;

    expect(() => extractMetadata(fileContent)).toThrow(FrontmatterParseError);
  });

  it('should support generic type parameter', () => {
    interface CustomMetadata {
      name: string;
      version: string;
    }

    const fileContent = `---
name: typed-skill
version: 2.0.0
---
Content`;

    const metadata = extractMetadata<CustomMetadata>(fileContent);

    expect(metadata.name).toBe('typed-skill');
    expect(metadata.version).toBe('2.0.0');
  });
});

describe('extractContent', () => {
  it('should extract content without metadata', () => {
    const fileContent = `---
name: test-skill
description: This metadata is ignored
---
# Important Content

This is the actual content.`;

    const content = extractContent(fileContent);

    expect(content).toBe('# Important Content\n\nThis is the actual content.');
  });

  it('should return empty string for no content', () => {
    const fileContent = `---
name: test-skill
---`;

    const content = extractContent(fileContent);

    expect(content).toBe('');
  });

  it('should throw error for invalid frontmatter', () => {
    const fileContent = `Invalid content`;

    expect(() => extractContent(fileContent)).toThrow(FrontmatterParseError);
  });

  it('should preserve markdown formatting in content', () => {
    const fileContent = `---
name: test-skill
---
# Heading 1
## Heading 2

- List item 1
- List item 2

\`\`\`javascript
const code = 'preserved';
\`\`\``;

    const content = extractContent(fileContent);

    expect(content).toContain('# Heading 1');
    expect(content).toContain('## Heading 2');
    expect(content).toContain('- List item 1');
    expect(content).toContain('```javascript');
  });
});

describe('FrontmatterParseError', () => {
  it('should create error with message and file path', () => {
    const error = new FrontmatterParseError(
      'Test error',
      '/test/path/file.md'
    );

    expect(error.message).toBe('Test error');
    expect(error.filePath).toBe('/test/path/file.md');
    expect(error.name).toBe('FrontmatterParseError');
  });

  it('should create error with cause', () => {
    const cause = new Error('Original error');
    const error = new FrontmatterParseError(
      'Test error',
      '/test/path/file.md',
      cause
    );

    expect(error.cause).toBe(cause);
  });

  it('should be instanceof Error', () => {
    const error = new FrontmatterParseError('Test error');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(FrontmatterParseError);
  });
});
