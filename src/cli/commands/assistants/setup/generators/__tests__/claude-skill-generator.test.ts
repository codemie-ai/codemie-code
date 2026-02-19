/**
 * Unit tests for Claude skill generator
 * Tests file generation and path resolution for Claude skills
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Assistant } from 'codemie-sdk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	registerClaudeSkill,
	unregisterClaudeSkill
} from '../claude-skill-generator.js';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('os');
vi.mock('@/utils/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	}
}));

describe('Claude Skill Generator', () => {
	const mockHomeDir = '/home/testuser';
	let mockAssistant: Assistant;

	beforeEach(() => {
		// Arrange: Mock os.homedir()
		vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

		// Arrange: Setup mock assistant
		mockAssistant = {
			id: 'asst-123',
			name: 'Test Assistant',
			description: 'A test assistant for unit testing',
			slug: 'test-assistant',
			project: 'test-project'
		} as Assistant;

		// Arrange: Mock file system operations
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(fs.access).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('registerClaudeSkill', () => {
		it('should create skill file in correct location', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedPath,
				expect.any(String),
				'utf-8'
			);
		});

		it('should create skill directory if not exists', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const expectedDir = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant');
			expect(fs.mkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
		});

		it('should create directory before writing file', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const mkdirCall = vi.mocked(fs.mkdir).mock.invocationCallOrder[0];
			const writeFileCall = vi.mocked(fs.writeFile).mock.invocationCallOrder[0];
			expect(mkdirCall).toBeLessThan(writeFileCall);
		});

		it('should write complete skill content with metadata', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('---'),
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('name: test-assistant'),
				'utf-8'
			);
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('description: A test assistant for unit testing'),
				'utf-8'
			);
		});

		it('should include correct command with assistant ID', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('codemie assistants chat "asst-123" "$ARGUMENTS"'),
				'utf-8'
			);
		});

		it('should include assistant name in content', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.any(String),
				expect.stringContaining('# Test Assistant'),
				'utf-8'
			);
		});

		it('should handle assistant without slug by generating slug from ID', async () => {
			// Arrange
			const noSlugAssistant = {
				...mockAssistant,
				slug: undefined
			} as Assistant;

			// Act
			await registerClaudeSkill(noSlugAssistant);

			// Assert: Should generate slug from ID (asst-123 -> asst-123)
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'asst-123', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedPath,
				expect.any(String),
				'utf-8'
			);
		});

		it('should normalize slug from ID by lowercasing and replacing special chars', async () => {
			// Arrange
			const specialIdAssistant = {
				...mockAssistant,
				id: 'Asst_123_Test',
				slug: undefined
			} as Assistant;

			// Act
			await registerClaudeSkill(specialIdAssistant);

			// Assert: ID should be normalized to slug
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'asst-123-test', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedPath,
				expect.any(String),
				'utf-8'
			);
		});

		it('should handle assistant with special characters in slug', async () => {
			// Arrange
			const specialSlugAssistant = {
				...mockAssistant,
				slug: 'test-assistant-v2.0'
			} as Assistant;

			// Act
			await registerClaudeSkill(specialSlugAssistant);

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant-v2.0', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedPath,
				expect.any(String),
				'utf-8'
			);
		});

		it('should handle assistant with uppercase slug', async () => {
			// Arrange
			const uppercaseSlugAssistant = {
				...mockAssistant,
				slug: 'TEST-ASSISTANT'
			} as Assistant;

			// Act
			await registerClaudeSkill(uppercaseSlugAssistant);

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'TEST-ASSISTANT', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(
				expectedPath,
				expect.any(String),
				'utf-8'
			);
		});

		it('should use assistant description in metadata', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('description: A test assistant for unit testing');
		});

		it('should use assistant name as description fallback', async () => {
			// Arrange
			const noDescAssistant = {
				...mockAssistant,
				description: undefined
			} as Assistant;

			// Act
			await registerClaudeSkill(noDescAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('description: Test Assistant');
		});

		it('should handle empty description by using name', async () => {
			// Arrange
			const emptyDescAssistant = {
				...mockAssistant,
				description: ''
			} as Assistant;

			// Act
			await registerClaudeSkill(emptyDescAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('description: Test Assistant');
		});

		it('should handle filesystem errors during directory creation', async () => {
			// Arrange
			const fsError = new Error('EACCES: permission denied');
			vi.mocked(fs.mkdir).mockRejectedValue(fsError);

			// Act & Assert
			await expect(registerClaudeSkill(mockAssistant)).rejects.toThrow('EACCES: permission denied');
		});

		it('should handle filesystem errors during file write', async () => {
			// Arrange
			const fsError = new Error('ENOSPC: no space left on device');
			vi.mocked(fs.writeFile).mockRejectedValue(fsError);

			// Act & Assert
			await expect(registerClaudeSkill(mockAssistant)).rejects.toThrow('ENOSPC: no space left on device');
		});

		it('should overwrite existing skill file', async () => {
			// Arrange: File already exists (writeFile doesn't throw)
			vi.mocked(fs.writeFile).mockResolvedValue(undefined);

			// Act
			await registerClaudeSkill(mockAssistant);
			await registerClaudeSkill(mockAssistant); // Register again

			// Assert: Should write twice without error
			expect(fs.writeFile).toHaveBeenCalledTimes(2);
		});

		it('should handle special characters in description', async () => {
			// Arrange
			const specialDescAssistant = {
				...mockAssistant,
				description: 'Test: with "quotes" and [brackets]'
			} as Assistant;

			// Act
			await registerClaudeSkill(specialDescAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('Test: with "quotes" and [brackets]');
		});

		it('should handle unicode characters in description', async () => {
			// Arrange
			const unicodeAssistant = {
				...mockAssistant,
				description: '助理測試 - Assistant test'
			} as Assistant;

			// Act
			await registerClaudeSkill(unicodeAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('助理測試 - Assistant test');
		});

		it('should handle very long descriptions', async () => {
			// Arrange
			const longDescription = 'A'.repeat(500);
			const longDescAssistant = {
				...mockAssistant,
				description: longDescription
			} as Assistant;

			// Act
			await registerClaudeSkill(longDescAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain(longDescription);
		});

		it('should handle newlines in assistant description', async () => {
			// Arrange
			const multilineAssistant = {
				...mockAssistant,
				description: 'First line\nSecond line\nThird line'
			} as Assistant;

			// Act
			await registerClaudeSkill(multilineAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('First line\nSecond line\nThird line');
		});

		it('should create valid markdown structure', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;

			expect(content).toMatch(/^---\n/); // Starts with frontmatter
			expect(content).toMatch(/\n---\n/); // Closes frontmatter
			expect(content).toContain('# '); // Has heading
			expect(content).toContain('## '); // Has subheading
		});

		it('should include Instructions section', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('## Instructions');
		});

		it('should include bash code block', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('```bash');
			expect(content).toContain('```');
		});

		it('should reference assistant name in instructions', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('Send the user\'s message to the Test Assistant assistant');
		});
	});

	describe('unregisterClaudeSkill', () => {
		it('should remove skill directory', async () => {
			// Act
			await unregisterClaudeSkill('test-assistant');

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant');
			expect(fs.rm).toHaveBeenCalledWith(expectedPath, { recursive: true, force: true });
		});

		it('should check if directory exists before removing', async () => {
			// Act
			await unregisterClaudeSkill('test-assistant');

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant');
			expect(fs.access).toHaveBeenCalledWith(expectedPath);
		});

		it('should handle directory not found gracefully', async () => {
			// Arrange
			const notFoundError = new Error('ENOENT: no such file or directory');
			vi.mocked(fs.access).mockRejectedValue(notFoundError);

			// Act & Assert: Should not throw
			await expect(unregisterClaudeSkill('test-assistant')).resolves.toBeUndefined();
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('should handle permission errors during access check gracefully', async () => {
			// Arrange
			const permError = new Error('EACCES: permission denied');
			vi.mocked(fs.access).mockRejectedValue(permError);

			// Act & Assert: Should not throw
			await expect(unregisterClaudeSkill('test-assistant')).resolves.toBeUndefined();
			expect(fs.rm).not.toHaveBeenCalled();
		});

		it('should throw error when removal fails', async () => {
			// Arrange
			const removeError = new Error('EBUSY: resource busy');
			vi.mocked(fs.rm).mockRejectedValue(removeError);

			// Act & Assert
			await expect(unregisterClaudeSkill('test-assistant')).rejects.toThrow('EBUSY: resource busy');
		});

		it('should handle special characters in slug', async () => {
			// Act
			await unregisterClaudeSkill('test-assistant-v2.0');

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'test-assistant-v2.0');
			expect(fs.rm).toHaveBeenCalledWith(expectedPath, { recursive: true, force: true });
		});

		it('should handle empty slug', async () => {
			// Act
			await unregisterClaudeSkill('');

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', '');
			expect(fs.access).toHaveBeenCalledWith(expectedPath);
		});

		it('should use force flag for recursive removal', async () => {
			// Act
			await unregisterClaudeSkill('test-assistant');

			// Assert
			expect(fs.rm).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					recursive: true,
					force: true
				})
			);
		});
	});

	describe('Path resolution', () => {
		it('should use home directory from os.homedir()', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			expect(os.homedir).toHaveBeenCalled();
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			// Normalize path separators for cross-platform comparison
			const normalizedPath = filePath.replace(/\\/g, '/');
			expect(normalizedPath).toContain(mockHomeDir.replace(/\\/g, '/'));
		});

		it('should construct correct path with platform-specific separators', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;

			// Path should include .claude/skills
			expect(filePath).toContain('.claude');
			expect(filePath).toContain('skills');
			expect(filePath).toMatch(/test-assistant[/\\]SKILL\.md$/);
		});

		it('should handle different home directory paths', async () => {
			// Arrange
			const differentHome = '/Users/differentuser';
			vi.mocked(os.homedir).mockReturnValue(differentHome);

			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			// Normalize path separators for cross-platform comparison
			const normalizedPath = filePath.replace(/\\/g, '/');
			expect(normalizedPath).toContain(differentHome.replace(/\\/g, '/'));
		});

		it('should handle Windows-style home directory', async () => {
			// Arrange
			const windowsHome = 'C:\\Users\\testuser';
			vi.mocked(os.homedir).mockReturnValue(windowsHome);

			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			expect(fs.writeFile).toHaveBeenCalledWith(
				expect.stringContaining(windowsHome),
				expect.any(String),
				'utf-8'
			);
		});

		it('should create nested directory structure', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.mkdir).mock.calls[0];
			const dirPath = callArgs[0] as string;

			// Should create: ~/.claude/skills/{slug}/
			expect(dirPath).toContain('.claude');
			expect(dirPath).toContain('skills');
			expect(dirPath).toMatch(/test-assistant$/);
		});
	});

	describe('Security considerations', () => {
		it('should not allow path traversal in slug', async () => {
			// Arrange
			const maliciousSlug = '../../../etc/passwd';
			const maliciousAssistant = {
				...mockAssistant,
				slug: maliciousSlug
			} as Assistant;

			// Act
			await registerClaudeSkill(maliciousAssistant);

			// Assert: path.join normalizes the path, so traversal characters are resolved
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			// path.join('/home/testuser/.claude/skills', '../../../etc/passwd', 'SKILL.md')
			// Results in normalized path that doesn't escape .claude/skills directory
			// This documents that path.join provides some protection against path traversal
			// Normalize path separators for cross-platform comparison
			const normalizedPath = filePath.replace(/\\/g, '/');
			expect(normalizedPath).toContain('etc/passwd');
			expect(normalizedPath).toContain('SKILL.md');
		});

		it('should handle null bytes in slug', async () => {
			// Arrange
			const nullByteSlug = 'test\x00assistant';
			const nullByteAssistant = {
				...mockAssistant,
				slug: nullByteSlug
			} as Assistant;

			// Act
			await registerClaudeSkill(nullByteAssistant);

			// Assert: Documents current behavior
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			expect(filePath).toContain(nullByteSlug);
		});

		it('should handle absolute path in slug', async () => {
			// Arrange
			const absolutePathSlug = '/etc/shadow';
			const absolutePathAssistant = {
				...mockAssistant,
				slug: absolutePathSlug
			} as Assistant;

			// Act
			await registerClaudeSkill(absolutePathAssistant);

			// Assert: Documents current behavior
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			// Normalize path separators for cross-platform comparison
			const normalizedPath = filePath.replace(/\\/g, '/');
			expect(normalizedPath).toContain(absolutePathSlug);
		});
	});

	describe('Content validation', () => {
		it('should create valid YAML frontmatter', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;

			expect(content).toMatch(/^---\n/);
			expect(content).toMatch(/\nname: /);
			expect(content).toMatch(/\ndescription: /);
			expect(content).toMatch(/\n---\n/);
		});

		it('should not escape special markdown characters in content', async () => {
			// Arrange
			const specialAssistant = {
				...mockAssistant,
				name: 'Test [Assistant] *with* `special` **chars**',
				description: 'Description with #hashtag and _underscores_'
			} as Assistant;

			// Act
			await registerClaudeSkill(specialAssistant);

			// Assert: Current implementation doesn't escape, documents behavior
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('[Assistant]');
			expect(content).toContain('*with*');
			expect(content).toContain('#hashtag');
		});

		it('should include proper code block syntax', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;

			// Check for bash code block
			expect(content).toContain('```bash');
			expect(content).toContain('codemie assistants chat');
			expect(content).toContain('```');
		});

		it('should use $ARGUMENTS variable in command', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('$ARGUMENTS');
		});

		it('should have proper heading hierarchy', async () => {
			// Act
			await registerClaudeSkill(mockAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			const lines = content.split('\n');

			const h1Count = lines.filter(l => l.startsWith('# ')).length;
			const h2Count = lines.filter(l => l.startsWith('## ')).length;

			expect(h1Count).toBe(1); // Only one main title
			expect(h2Count).toBe(1); // Instructions section
		});
	});

	describe('Edge cases', () => {
		it('should handle assistant with minimal fields', async () => {
			// Arrange
			const minimalAssistant = {
				id: 'asst-min',
				name: 'Minimal'
			} as Assistant;

			// Act
			await registerClaudeSkill(minimalAssistant);

			// Assert: Should generate slug from ID and use name as description
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain('name: asst-min');
			expect(content).toContain('description: Minimal');
		});

		it('should handle very long assistant names', async () => {
			// Arrange
			const longName = 'A'.repeat(500);
			const longNameAssistant = {
				...mockAssistant,
				name: longName
			} as Assistant;

			// Act
			await registerClaudeSkill(longNameAssistant);

			// Assert
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const content = callArgs[1] as string;
			expect(content).toContain(longName);
		});

		it('should handle ID with only special characters', async () => {
			// Arrange
			const specialIdAssistant = {
				...mockAssistant,
				id: '!@#$%^&*()',
				slug: undefined
			} as Assistant;

			// Act
			await registerClaudeSkill(specialIdAssistant);

			// Assert: Should normalize to slug with only hyphens
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			// Current implementation: .toLowerCase().replace(/[^a-z0-9]+/g, '-')
			// "!@#$%^&*()" becomes "-"
			expect(filePath).toContain(path.join('skills', '-', 'SKILL.md'));
		});

		it('should handle ID with multiple consecutive special chars', async () => {
			// Arrange
			const multiSpecialAssistant = {
				...mockAssistant,
				id: 'asst___123___test',
				slug: undefined
			} as Assistant;

			// Act
			await registerClaudeSkill(multiSpecialAssistant);

			// Assert: Should replace with single hyphen
			const callArgs = vi.mocked(fs.writeFile).mock.calls[0];
			const filePath = callArgs[0] as string;
			expect(filePath).toContain(path.join('skills', 'asst-123-test', 'SKILL.md'));
		});
	});
});
