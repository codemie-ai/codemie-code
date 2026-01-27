/**
 * Tests for HookExecutor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HookExecutor } from '../executor.js';
import type { HooksConfiguration, HookExecutionContext } from '../types.js';
import * as execModule from '../../utils/exec.js';

describe('HookExecutor', () => {
	let execSpy: ReturnType<typeof vi.spyOn>;
	let mockContext: HookExecutionContext;

	beforeEach(() => {
		execSpy = vi.spyOn(execModule, 'exec');
		mockContext = {
			sessionId: 'test-session-123',
			workingDir: '/tmp/test',
			transcriptPath: '/tmp/test/transcript.txt',
			permissionMode: 'auto',
			agentName: 'test-agent',
			profileName: 'default',
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('executeSessionStart', () => {
		it('should execute SessionStart hooks successfully', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						matcher: '*',
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
								timeout: 10000,
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 0,
				stdout: '{"decision": "allow", "additionalContext": "OS: Darwin"}',
				stderr: '',
			});

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			expect(execSpy).toHaveBeenCalledWith(
				'/test/hook.sh',
				[],
				expect.objectContaining({
					timeout: 10000,
					cwd: mockContext.workingDir,
					shell: true,
					env: expect.objectContaining({
						CODEMIE_SESSION_ID: 'test-session-123',
						CODEMIE_HOOK_EVENT: 'SessionStart',
						CODEMIE_AGENT_NAME: 'test-agent',
						CODEMIE_PROFILE_NAME: 'default',
					}),
				}),
			);

			expect(result.decision).toBe('allow');
			expect(result.additionalContext).toBe('OS: Darwin');
			expect(result.hooksExecuted).toBe(1);
			expect(result.hooksSucceeded).toBe(1);
			expect(result.hooksFailed).toBe(0);
		});

		it('should return empty result when no SessionStart hooks configured', async () => {
			const config: HooksConfiguration = {};
			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			expect(execSpy).not.toHaveBeenCalled();
			expect(result.decision).toBe('allow');
			expect(result.hooksExecuted).toBe(0);
		});

		it('should handle SessionStart hook failure gracefully', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
							},
						],
					},
				],
			};

			execSpy.mockRejectedValue(new Error('Hook script not found'));

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			// Should fail open (allow by default)
			expect(result.decision).toBe('allow');
			expect(result.hooksExecuted).toBe(1);
			// Hook failures are caught and converted to allow decisions, so hooksFailed is 0
			expect(result.hooksSucceeded).toBe(1);
		});

		it('should handle blocking decision from SessionStart hook', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 2,
				stdout: '',
				stderr: 'Missing required dependencies',
			});

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			expect(result.decision).toBe('block');
			expect(result.reason).toContain('Missing required dependencies');
		});

		it('should deduplicate identical SessionStart hooks', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
								timeout: 10000,
							},
							{
								type: 'command',
								command: '/test/hook.sh',
								timeout: 10000,
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 0,
				stdout: '{"decision": "allow"}',
				stderr: '',
			});

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			// Should only execute once due to deduplication
			expect(execSpy).toHaveBeenCalledTimes(1);
			expect(result.hooksExecuted).toBe(1);
		});

		it('should execute multiple different SessionStart hooks', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook1.sh',
							},
							{
								type: 'command',
								command: '/test/hook2.sh',
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 0,
				stdout: '{"decision": "allow"}',
				stderr: '',
			});

			const executor = new HookExecutor(config, mockContext);
			const result = await executor.executeSessionStart();

			expect(execSpy).toHaveBeenCalledTimes(2);
			expect(result.hooksExecuted).toBe(2);
		});

		it('should pass session context in hook input', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 0,
				stdout: '{"decision": "allow"}',
				stderr: '',
			});

			const executor = new HookExecutor(config, mockContext);
			await executor.executeSessionStart();

			const callArgs = execSpy.mock.calls[0];
			const envVars = callArgs[2]?.env as Record<string, string>;
			const hookInput = JSON.parse(envVars.CODEMIE_HOOK_INPUT);

			expect(hookInput.hook_event_name).toBe('SessionStart');
			expect(hookInput.session_id).toBe('test-session-123');
			expect(hookInput.cwd).toBe('/tmp/test');
			expect(hookInput.agent_name).toBe('test-agent');
			expect(hookInput.profile_name).toBe('default');
			expect(hookInput.permission_mode).toBe('auto');
			expect(hookInput.tool_name).toBeUndefined();
			expect(hookInput.tool_input).toBeUndefined();
		});
	});

	describe('clearCache', () => {
		it('should clear hook execution cache', async () => {
			const config: HooksConfiguration = {
				SessionStart: [
					{
						hooks: [
							{
								type: 'command',
								command: '/test/hook.sh',
							},
						],
					},
				],
			};

			execSpy.mockResolvedValue({
				code: 0,
				stdout: '{"decision": "allow"}',
				stderr: '',
			});

			const executor = new HookExecutor(config, mockContext);

			// Execute once
			await executor.executeSessionStart();
			expect(execSpy).toHaveBeenCalledTimes(1);

			// Execute again without clearing cache - should be skipped (deduplication)
			await executor.executeSessionStart();
			expect(execSpy).toHaveBeenCalledTimes(1);

			// Clear cache and execute again - should run
			executor.clearCache();
			await executor.executeSessionStart();
			expect(execSpy).toHaveBeenCalledTimes(2);
		});
	});
});
