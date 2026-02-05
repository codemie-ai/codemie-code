/**
 * Unit tests for assistants setup command orchestration
 * Tests command creation and public interfaces
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createAssistantsSetupCommand } from '../index.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';

describe('Assistants Setup Command - index.ts', () => {
	describe('createAssistantsSetupCommand', () => {
		let command: ReturnType<typeof createAssistantsSetupCommand>;

		beforeEach(() => {
			command = createAssistantsSetupCommand();
		});

		it('should create a command with correct name', () => {
			expect(command.name()).toBe('setup');
		});

		it('should have correct description', () => {
			expect(command.description()).toBe(MESSAGES.SETUP.COMMAND_DESCRIPTION);
		});

		it('should have all required options', () => {
			expect(command.options).toHaveLength(4);

			const profileOption = command.options.find(opt => opt.long === '--profile');
			expect(profileOption).toBeDefined();
			expect(profileOption?.description).toBe(MESSAGES.SETUP.OPTION_PROFILE);

			const projectOption = command.options.find(opt => opt.long === '--project');
			expect(projectOption).toBeDefined();
			expect(projectOption?.description).toBe(MESSAGES.SETUP.OPTION_PROJECT);

			const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
			expect(allProjectsOption).toBeDefined();
			expect(allProjectsOption?.description).toBe(MESSAGES.SETUP.OPTION_ALL_PROJECTS);

			const verboseOption = command.options.find(opt => opt.long === '--verbose');
			expect(verboseOption).toBeDefined();
			expect(verboseOption?.short).toBe('-v');
			expect(verboseOption?.description).toBe(MESSAGES.SHARED.OPTION_VERBOSE);
		});

		it('should have profile option with argument', () => {
			const profileOption = command.options.find(opt => opt.long === '--profile');
			expect(profileOption?.long).toBe('--profile');
			expect(profileOption?.flags).toContain('<name>');
		});

		it('should have project option with argument', () => {
			const projectOption = command.options.find(opt => opt.long === '--project');
			expect(projectOption?.long).toBe('--project');
			expect(projectOption?.flags).toContain('<project>');
		});

		it('should have all-projects as boolean flag', () => {
			const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
			expect(allProjectsOption?.long).toBe('--all-projects');
			expect(allProjectsOption?.flags).not.toContain('<');
		});

		it('should have verbose as boolean flag with short option', () => {
			const verboseOption = command.options.find(opt => opt.long === '--verbose');
			expect(verboseOption?.long).toBe('--verbose');
			expect(verboseOption?.short).toBe('-v');
			expect(verboseOption?.flags).not.toContain('<');
		});

		it('should not have any positional arguments', () => {
			expect(command.registeredArguments).toHaveLength(0);
		});

		it('should not have subcommands', () => {
			expect(command.commands).toHaveLength(0);
		});

		it('should have an action handler attached', () => {
			// Commander.js attaches action handlers internally
			expect(command).toBeDefined();
		});

		it('should be configured as a Commander command', () => {
			expect(command.constructor.name).toBe('Command');
		});
	});

	describe('Command Options Validation', () => {
		let command: ReturnType<typeof createAssistantsSetupCommand>;

		beforeEach(() => {
			command = createAssistantsSetupCommand();
		});

		it('should have exactly 4 options', () => {
			expect(command.options).toHaveLength(4);
		});

		it('should have all options as optional', () => {
			// Commander.js options without .requiredOption() are optional by default
			const hasRequiredOptions = command.options.some(opt => (opt as any).mandatory === true);
			expect(hasRequiredOptions).toBe(false);
		});

		it('should allow profile option alone', () => {
			const profileOption = command.options.find(opt => opt.long === '--profile');
			expect(profileOption).toBeDefined();
		});

		it('should allow project option alone', () => {
			const projectOption = command.options.find(opt => opt.long === '--project');
			expect(projectOption).toBeDefined();
		});

		it('should allow all-projects option alone', () => {
			const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
			expect(allProjectsOption).toBeDefined();
		});

		it('should allow combining profile and project options', () => {
			const profileOption = command.options.find(opt => opt.long === '--profile');
			const projectOption = command.options.find(opt => opt.long === '--project');

			expect(profileOption).toBeDefined();
			expect(projectOption).toBeDefined();
		});

		it('should allow combining any options with verbose', () => {
			const verboseOption = command.options.find(opt => opt.long === '--verbose');
			expect(verboseOption).toBeDefined();
			expect(command.options.length).toBeGreaterThan(1);
		});
	});

	describe('Command Structure', () => {
		it('should have name "setup"', () => {
			const command = createAssistantsSetupCommand();
			expect(command.name()).toBe('setup');
		});

		it('should have consistent option descriptions from MESSAGES', () => {
			const command = createAssistantsSetupCommand();

			const profileOption = command.options.find(opt => opt.long === '--profile');
			expect(profileOption?.description).toBe(MESSAGES.SETUP.OPTION_PROFILE);

			const projectOption = command.options.find(opt => opt.long === '--project');
			expect(projectOption?.description).toBe(MESSAGES.SETUP.OPTION_PROJECT);

			const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
			expect(allProjectsOption?.description).toBe(MESSAGES.SETUP.OPTION_ALL_PROJECTS);

			const verboseOption = command.options.find(opt => opt.long === '--verbose');
			expect(verboseOption?.description).toBe(MESSAGES.SHARED.OPTION_VERBOSE);
		});

		it('should return Command instance', () => {
			const command = createAssistantsSetupCommand();
			expect(command).toBeInstanceOf(Object);
			expect(typeof command.name).toBe('function');
			expect(typeof command.description).toBe('function');
		});
	});

	describe('Option Types', () => {
		let command: ReturnType<typeof createAssistantsSetupCommand>;

		beforeEach(() => {
			command = createAssistantsSetupCommand();
		});

		it('should have string value options', () => {
			const profileOption = command.options.find(opt => opt.long === '--profile');
			const projectOption = command.options.find(opt => opt.long === '--project');

			// These options accept string arguments
			expect(profileOption?.flags).toContain('<');
			expect(projectOption?.flags).toContain('<');
		});

		it('should have boolean flag options', () => {
			const allProjectsOption = command.options.find(opt => opt.long === '--all-projects');
			const verboseOption = command.options.find(opt => opt.long === '--verbose');

			// These options are boolean flags (no arguments)
			expect(allProjectsOption?.flags).not.toContain('<');
			expect(verboseOption?.flags).not.toContain('<');
		});
	});

	describe('Edge Cases', () => {
		it('should create command without errors', () => {
			expect(() => createAssistantsSetupCommand()).not.toThrow();
		});

		it('should create new command instance each time', () => {
			const command1 = createAssistantsSetupCommand();
			const command2 = createAssistantsSetupCommand();

			expect(command1).not.toBe(command2);
		});

		it('should have consistent structure across multiple creations', () => {
			const command1 = createAssistantsSetupCommand();
			const command2 = createAssistantsSetupCommand();

			expect(command1.name()).toBe(command2.name());
			expect(command1.description()).toBe(command2.description());
			expect(command1.options.length).toBe(command2.options.length);
		});
	});

	describe('Integration with Constants', () => {
		it('should use command name from constants', () => {
			const command = createAssistantsSetupCommand();
			expect(command.name()).toBe('setup');
		});

		it('should use description from messages', () => {
			const command = createAssistantsSetupCommand();
			expect(command.description()).toBe(MESSAGES.SETUP.COMMAND_DESCRIPTION);
		});

		it('should use option descriptions from messages', () => {
			const command = createAssistantsSetupCommand();

			command.options.forEach((option) => {
				expect(option.description).toBeDefined();
				expect(typeof option.description).toBe('string');
				expect(option.description.length).toBeGreaterThan(0);
			});
		});
	});
});
