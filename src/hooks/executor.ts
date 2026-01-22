/**
 * Hook Executor
 *
 * Orchestrates execution of hooks at various lifecycle points.
 * Handles pattern matching, deduplication, parallel execution, and timeout management.
 */

import crypto from 'crypto';
import { exec } from '../utils/exec.js';
import { logger } from '../utils/logger.js';
import { sanitizeValue } from '../utils/security.js';
import { HookMatcher } from './matcher.js';
import { DecisionParser } from './decision.js';
import { PromptHookExecutor } from './prompt-executor.js';
import type {
	HooksConfiguration,
	HookConfig,
	HookMatcher as HookMatcherConfig,
	HookInput,
	HookResult,
	AggregatedHookResult,
	HookExecutionContext,
} from './types.js';

/**
 * Default timeout for hook execution (60 seconds)
 */
const DEFAULT_HOOK_TIMEOUT = 60000;

/**
 * LLM configuration for prompt hooks
 */
export interface PromptHookLLMConfig {
	apiKey: string;
	baseUrl?: string;
	model?: string;
	timeout?: number;
	debug?: boolean;
}

/**
 * Hook execution engine
 * Manages lifecycle hook execution with pattern matching, deduplication, and aggregation
 */
export class HookExecutor {
	/** Hooks configuration */
	private config: HooksConfiguration;

	/** Execution context (session ID, working directory, etc.) */
	private context: HookExecutionContext;

	/** Cache of executed hooks (for deduplication) */
	private executedHooks: Set<string> = new Set();

	/** Prompt hook executor (for LLM-based hooks) */
	private promptExecutor: PromptHookExecutor | null = null;

	constructor(
		config: HooksConfiguration,
		context: HookExecutionContext,
		llmConfig?: PromptHookLLMConfig,
	) {
		this.config = config;
		this.context = context;

		// Initialize prompt executor if LLM config provided
		if (llmConfig) {
			this.promptExecutor = new PromptHookExecutor(llmConfig);
		}
	}

	/**
	 * Execute PreToolUse hooks
	 * Runs before tool execution, can block or modify tool input
	 *
	 * @param toolName - Name of tool being executed
	 * @param toolInput - Tool input arguments
	 * @param toolUseId - Unique identifier for this tool use
	 * @returns Aggregated result from all matching hooks
	 */
	async executePreToolUse(
		toolName: string,
		toolInput: Record<string, unknown>,
		toolUseId?: string,
	): Promise<AggregatedHookResult> {
		logger.debug(`Executing PreToolUse hooks for tool: ${toolName}`);

		const matchers = this.config.PreToolUse || [];
		const matchingHooks = this.findMatchingHooks(matchers, toolName);

		if (matchingHooks.length === 0) {
			logger.debug(`No PreToolUse hooks matched for: ${toolName}`);
			return this.createEmptyResult();
		}

		const input: HookInput = {
			hook_event_name: 'PreToolUse',
			session_id: this.context.sessionId,
			transcript_path: this.context.transcriptPath,
			cwd: this.context.workingDir,
			permission_mode: this.context.permissionMode,
			tool_name: toolName,
			tool_input: toolInput,
			tool_use_id: toolUseId,
			agent_name: this.context.agentName,
			profile_name: this.context.profileName,
		};

		return this.executeHooks(matchingHooks, input);
	}

	/**
	 * Execute PostToolUse hooks
	 * Runs after tool completes, informational only (cannot block)
	 *
	 * @param toolName - Name of tool that was executed
	 * @param toolInput - Tool input arguments
	 * @param toolOutput - Tool output/result
	 * @param toolMetadata - Additional tool metadata
	 * @returns Aggregated result from all matching hooks
	 */
	async executePostToolUse(
		toolName: string,
		toolInput: Record<string, unknown>,
		toolOutput: string,
		toolMetadata?: Record<string, unknown>,
	): Promise<AggregatedHookResult> {
		logger.debug(`Executing PostToolUse hooks for tool: ${toolName}`);

		const matchers = this.config.PostToolUse || [];
		const matchingHooks = this.findMatchingHooks(matchers, toolName);

		if (matchingHooks.length === 0) {
			logger.debug(`No PostToolUse hooks matched for: ${toolName}`);
			return this.createEmptyResult();
		}

		const input: HookInput = {
			hook_event_name: 'PostToolUse',
			session_id: this.context.sessionId,
			transcript_path: this.context.transcriptPath,
			cwd: this.context.workingDir,
			permission_mode: this.context.permissionMode,
			tool_name: toolName,
			tool_input: toolInput,
			tool_output: toolOutput,
			tool_metadata: toolMetadata,
			agent_name: this.context.agentName,
			profile_name: this.context.profileName,
		};

		return this.executeHooks(matchingHooks, input);
	}

	/**
	 * Execute UserPromptSubmit hooks
	 * Runs before processing user input, can block or add context
	 *
	 * @param prompt - User's prompt text
	 * @returns Aggregated result from all hooks
	 */
	async executeUserPromptSubmit(prompt: string): Promise<AggregatedHookResult> {
		logger.debug('Executing UserPromptSubmit hooks');

		const matchers = this.config.UserPromptSubmit || [];
		// UserPromptSubmit hooks don't use matchers (always run)
		const allHooks = matchers.flatMap((m) => m.hooks);

		if (allHooks.length === 0) {
			logger.debug('No UserPromptSubmit hooks configured');
			return this.createEmptyResult();
		}

		const input: HookInput = {
			hook_event_name: 'UserPromptSubmit',
			session_id: this.context.sessionId,
			transcript_path: this.context.transcriptPath,
			cwd: this.context.workingDir,
			permission_mode: this.context.permissionMode,
			prompt,
			agent_name: this.context.agentName,
			profile_name: this.context.profileName,
		};

		return this.executeHooks(allHooks, input);
	}

	/**
	 * Execute Stop hooks
	 * Runs when agent completes, can prevent stopping and continue execution
	 *
	 * @param executionSteps - Optional array of execution steps with tool history
	 * @param stats - Optional execution statistics
	 * @returns Aggregated result from all hooks
	 */
	async executeStop(
		executionSteps?: Array<any>,
		stats?: { toolCalls: number; successfulTools: number; failedTools: number },
	): Promise<AggregatedHookResult> {
		logger.debug('Executing Stop hooks');

		const matchers = this.config.Stop || [];
		// Stop hooks don't use matchers (always run)
		const allHooks = matchers.flatMap((m) => m.hooks);

		if (allHooks.length === 0) {
			logger.debug('No Stop hooks configured');
			return this.createEmptyResult();
		}

		// Format tool execution history from execution steps
		const toolExecutionHistory =
			executionSteps
				?.filter((step) => step.type === 'tool_execution')
				.map((step) => ({
					toolName: step.toolName || 'unknown',
					success: step.toolSuccess ?? false,
					exitCode: step.toolMetadata?.exitCode,
					duration: step.duration,
					errorMessage: step.error || step.toolMetadata?.errorMessage,
				})) || [];

		const input: HookInput = {
			hook_event_name: 'Stop',
			session_id: this.context.sessionId,
			transcript_path: this.context.transcriptPath,
			cwd: this.context.workingDir,
			permission_mode: this.context.permissionMode,
			agent_name: this.context.agentName,
			profile_name: this.context.profileName,
			tool_execution_history: toolExecutionHistory.length > 0 ? toolExecutionHistory : undefined,
			execution_stats: stats
				? {
						totalToolCalls: stats.toolCalls,
						successfulTools: stats.successfulTools,
						failedTools: stats.failedTools,
					}
				: undefined,
		};

		return this.executeHooks(allHooks, input);
	}

	/**
	 * Execute SessionStart hooks
	 * Runs at the beginning of a session, can block session start and inject context
	 *
	 * @returns Aggregated result from all hooks
	 */
	async executeSessionStart(): Promise<AggregatedHookResult> {
		logger.debug('Executing SessionStart hooks');

		const matchers = this.config.SessionStart || [];
		// SessionStart hooks don't use matchers (always run)
		const allHooks = matchers.flatMap((m) => m.hooks);

		if (allHooks.length === 0) {
			logger.debug('No SessionStart hooks configured');
			return this.createEmptyResult();
		}

		const input: HookInput = {
			hook_event_name: 'SessionStart',
			session_id: this.context.sessionId,
			transcript_path: this.context.transcriptPath,
			cwd: this.context.workingDir,
			permission_mode: this.context.permissionMode,
			agent_name: this.context.agentName,
			profile_name: this.context.profileName,
		};

		return this.executeHooks(allHooks, input);
	}

	/**
	 * Find hooks that match a tool name
	 *
	 * @param matchers - Array of hook matchers with patterns
	 * @param toolName - Tool name to match against
	 * @returns Array of matching hook configurations
	 */
	private findMatchingHooks(
		matchers: HookMatcherConfig[],
		toolName: string,
	): HookConfig[] {
		const matchingHooks: HookConfig[] = [];

		for (const matcher of matchers) {
			const pattern = matcher.matcher || '*';
			if (HookMatcher.matches(pattern, toolName)) {
				logger.debug(`Pattern "${pattern}" matched tool: ${toolName}`);
				matchingHooks.push(...matcher.hooks);
			}
		}

		return matchingHooks;
	}

	/**
	 * Execute multiple hooks in parallel with deduplication
	 *
	 * @param hooks - Hooks to execute
	 * @param input - Input data to pass to hooks
	 * @returns Aggregated result from all hooks
	 */
	private async executeHooks(
		hooks: HookConfig[],
		input: HookInput,
	): Promise<AggregatedHookResult> {
		// Deduplicate hooks by hash
		const uniqueHooks = this.deduplicateHooks(hooks);

		logger.debug(
			`Executing ${uniqueHooks.length} unique hooks (${hooks.length} total after deduplication)`,
		);

		// Execute hooks in parallel
		const results = await Promise.allSettled(
			uniqueHooks.map((hook) => this.executeSingleHook(hook, input)),
		);

		// Merge results according to priority rules
		return DecisionParser.merge(results);
	}

	/**
	 * Deduplicate hooks by computing hash of configuration
	 * Identical hooks (same command/prompt/timeout) run only once per event
	 *
	 * @param hooks - Hooks to deduplicate
	 * @returns Unique hooks
	 */
	private deduplicateHooks(hooks: HookConfig[]): HookConfig[] {
		const uniqueHooks: HookConfig[] = [];
		const seenHashes = new Set<string>();

		for (const hook of hooks) {
			const hash = this.hashHook(hook);

			// Check if already executed in this event cycle
			if (this.executedHooks.has(hash)) {
				logger.debug('Skipping hook (already executed this event)');
				continue;
			}

			// Check if duplicate in current batch
			if (seenHashes.has(hash)) {
				logger.debug('Skipping duplicate hook in batch');
				continue;
			}

			seenHashes.add(hash);
			this.executedHooks.add(hash);
			uniqueHooks.push(hook);
		}

		return uniqueHooks;
	}

	/**
	 * Compute hash of hook configuration for deduplication
	 *
	 * @param hook - Hook configuration
	 * @returns SHA-256 hash of hook config
	 */
	private hashHook(hook: HookConfig): string {
		const data = JSON.stringify({
			type: hook.type,
			command: hook.command,
			prompt: hook.prompt,
			timeout: hook.timeout || DEFAULT_HOOK_TIMEOUT,
		});

		return crypto.createHash('sha256').update(data).digest('hex');
	}

	/**
	 * Execute a single hook (command or prompt)
	 *
	 * @param hook - Hook configuration
	 * @param input - Input data for hook
	 * @returns Hook result
	 */
	private async executeSingleHook(
		hook: HookConfig,
		input: HookInput,
	): Promise<HookResult> {
		try {
			if (hook.type === 'command') {
				return await this.executeCommandHook(hook, input);
			} else if (hook.type === 'prompt') {
				return await this.executePromptHook(hook, input);
			} else {
				logger.warn(`Unknown hook type: ${hook.type}`);
				return { decision: 'allow', reason: `Unknown hook type: ${hook.type}` };
			}
		} catch (error) {
			logger.error(`Hook execution failed: ${error}`);
			// Fail open (allow execution to continue)
			return {
				decision: 'allow',
				reason: `Hook failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Execute a command hook (shell script)
	 *
	 * @param hook - Hook configuration
	 * @param input - Input data (passed as JSON via stdin)
	 * @returns Hook result parsed from stdout
	 */
	private async executeCommandHook(
		hook: HookConfig,
		input: HookInput,
	): Promise<HookResult> {
		if (!hook.command) {
			throw new Error('Command hook missing required field: command');
		}

		logger.debug(`Executing command hook: ${hook.command}`);

		// Build environment variables
		const env = this.buildEnvironment(input);

		// Sanitize input before passing to hook
		const sanitizedInput = {
			...input,
			tool_input: input.tool_input ? sanitizeValue(input.tool_input) : undefined,
			tool_output: input.tool_output ? sanitizeValue(input.tool_output) : undefined,
		};

		// Prepare stdin (JSON)
		const stdin = JSON.stringify(sanitizedInput, null, 2);

		// Execute command with timeout
		// Note: We're passing stdin via environment variable for now
		// In production, we'd use a proper stdin pipe
		const result = await exec(
			hook.command,
			[],
			{
				timeout: hook.timeout || DEFAULT_HOOK_TIMEOUT,
				env: {
					...env,
					CODEMIE_HOOK_INPUT: stdin, // Pass input via env for now
				},
				cwd: this.context.workingDir,
				shell: true, // Enable shell execution for proper command parsing
			},
		);

		// Log raw output for debugging
		if (result.stdout) {
			logger.debug(`Hook stdout: ${result.stdout}`);
		}
		if (result.stderr) {
			logger.debug(`Hook stderr: ${result.stderr}`);
		}

		// Parse result based on exit code and output
		return DecisionParser.parse(result.stdout, result.stderr, result.code);
	}

	/**
	 * Execute a prompt hook (LLM-based)
	 *
	 * @param hook - Hook configuration
	 * @param input - Input data
	 * @returns Hook result
	 */
	private async executePromptHook(
		hook: HookConfig,
		input: HookInput,
	): Promise<HookResult> {
		if (!hook.prompt) {
			throw new Error('Prompt hook missing required field: prompt');
		}

		// Check if prompt executor is available
		if (!this.promptExecutor) {
			logger.warn('Prompt hook requested but no LLM configuration provided, allowing by default');
			return {
				decision: 'allow',
				reason: 'Prompt hooks require LLM configuration',
			};
		}

		logger.debug('Executing prompt hook');

		// Execute prompt hook via LLM
		return this.promptExecutor.execute(hook.prompt, input);
	}

	/**
	 * Build environment variables for hook execution
	 *
	 * @param input - Hook input data
	 * @returns Environment variables object
	 */
	private buildEnvironment(input: HookInput): NodeJS.ProcessEnv {
		return {
			...process.env,
			CODEMIE_PROJECT_DIR: this.context.workingDir,
			CODEMIE_SESSION_ID: this.context.sessionId,
			CODEMIE_HOOK_EVENT: input.hook_event_name,
			CODEMIE_TOOL_NAME: input.tool_name || '',
			CODEMIE_AGENT_NAME: this.context.agentName || '',
			CODEMIE_PROFILE_NAME: this.context.profileName || '',
			CODEMIE_TRANSCRIPT_PATH: this.context.transcriptPath,
			CODEMIE_PERMISSION_MODE: this.context.permissionMode,
		};
	}

	/**
	 * Create empty result (no hooks executed)
	 *
	 * @returns Empty aggregated result
	 */
	private createEmptyResult(): AggregatedHookResult {
		return {
			decision: 'allow',
			hooksExecuted: 0,
			hooksSucceeded: 0,
			hooksFailed: 0,
		};
	}

	/**
	 * Clear executed hooks cache (for new event cycle)
	 */
	clearCache(): void {
		this.executedHooks.clear();
	}
}
