/**
 * Unit tests for skills claude-skill-generator
 * Tests SKILL.md generation using the codemie skill run template
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SkillDetail } from 'codemie-sdk';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
	registerClaudeSkill,
	unregisterClaudeSkill,
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

describe('Skills Claude Skill Generator', () => {
	const mockHomeDir = '/home/testuser';
	let mockSkill: SkillDetail;

	beforeEach(() => {
		// Arrange: Mock os.homedir()
		vi.mocked(os.homedir).mockReturnValue(mockHomeDir);

		// Arrange: Setup mock skill
		mockSkill = {
			id: 'skill-abc-123',
			name: 'My Test Skill',
			description: 'A test skill for unit testing',
			content: 'You are a helpful assistant.',
			toolkits: [],
			mcp_servers: [],
			skills: [],
		} as unknown as SkillDetail;

		// Arrange: Mock file system operations
		vi.mocked(fs.mkdir).mockResolvedValue(undefined);
		vi.mocked(fs.writeFile).mockResolvedValue(undefined);
		vi.mocked(fs.rm).mockResolvedValue(undefined);
		vi.mocked(fs.access).mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('registerClaudeSkill — file path', () => {
		it('should create skill file in correct global location', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'my-test-skill-global', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
		});

		it('should create skill directory before writing file', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert: mkdir called before writeFile
			const mkdirOrder = vi.mocked(fs.mkdir).mock.invocationCallOrder[0];
			const writeOrder = vi.mocked(fs.writeFile).mock.invocationCallOrder[0];
			expect(mkdirOrder).toBeLessThan(writeOrder);
		});

		it('should create skill file in local scope when specified', async () => {
			// Act
			const workingDir = '/some/project';
			await registerClaudeSkill(mockSkill, 'local', workingDir);

			// Assert
			const expectedPath = path.join(workingDir, '.claude', 'skills', 'my-test-skill-local', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
		});
	});

	describe('registerClaudeSkill — slug generation', () => {
		it('should generate slug from skill name', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert: slug derived from name "My Test Skill" → "my-test-skill-global"
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'my-test-skill-global', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
		});

		it('should normalise special characters in name to hyphens', async () => {
			// Arrange
			const specialSkill = { ...mockSkill, name: 'Code Review & Analysis!' } as unknown as SkillDetail;

			// Act
			await registerClaudeSkill(specialSkill);

			// Assert
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'code-review-analysis-global', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
		});

		it('should fall back to skill ID when name produces empty slug', async () => {
			// Arrange: name with only special characters that strip away
			const noNameSkill = { ...mockSkill, name: '!@#$%' } as unknown as SkillDetail;

			// Act
			await registerClaudeSkill(noNameSkill);

			// Assert: falls back to id "skill-abc-123-global"
			const expectedPath = path.join(mockHomeDir, '.claude', 'skills', 'skill-abc-123-global', 'SKILL.md');
			expect(fs.writeFile).toHaveBeenCalledWith(expectedPath, expect.any(String), 'utf-8');
		});
	});

	describe('createSkillContent — template output', () => {
		it('should include YAML frontmatter with name and description', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('---');
			expect(content).toContain('name: my-test-skill');
			expect(content).toContain('description: A test skill for unit testing');
		});

		it('should include skill name as H1 heading', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('# My Test Skill');
		});

		it('should include description in body', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('A test skill for unit testing');
		});

		it('should include the codemie skill run command with correct skill ID', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('codemie skill run "skill-abc-123" "message"');
		});

		it('should include the Instructions section', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('## Instructions');
			expect(content).toContain('Execute the command with the message');
		});

		it('should include the Examples section with skill ID', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('## Examples');
			expect(content).toContain('codemie skill run "skill-abc-123" "help me with this"');
		});

		it('should NOT embed raw skill content in the SKILL.md', async () => {
			// Act
			await registerClaudeSkill(mockSkill);

			// Assert: raw system prompt content should not appear verbatim
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).not.toContain('You are a helpful assistant.');
		});
	});

	describe('createSkillContent — description fallback', () => {
		it('should use skill name as description when description is absent', async () => {
			// Arrange
			const noDescSkill = { ...mockSkill, description: undefined } as unknown as SkillDetail;

			// Act
			await registerClaudeSkill(noDescSkill);

			// Assert: name used as fallback in frontmatter and body
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('description: My Test Skill');
			expect(content).toContain('My Test Skill');
		});

		it('should use skill name as description when description is empty string', async () => {
			// Arrange
			const emptyDescSkill = { ...mockSkill, description: '' } as unknown as SkillDetail;

			// Act
			await registerClaudeSkill(emptyDescSkill);

			// Assert: empty string is falsy, falls back to name
			const content = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
			expect(content).toContain('description: My Test Skill');
		});
	});

	describe('unregisterClaudeSkill', () => {
		it('should remove skill directory for given slug', async () => {
			// Act
			await unregisterClaudeSkill('my-test-skill');

			// Assert
			const expectedDir = path.join(mockHomeDir, '.claude', 'skills', 'my-test-skill');
			expect(fs.rm).toHaveBeenCalledWith(expectedDir, { recursive: true, force: true });
		});

		it('should do nothing when skill directory does not exist', async () => {
			// Arrange: fs.access throws (directory not found)
			vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

			// Act
			await unregisterClaudeSkill('non-existent-skill');

			// Assert: rm is not called
			expect(fs.rm).not.toHaveBeenCalled();
		});
	});
});
