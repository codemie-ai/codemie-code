/**
 * Prompt Hook Executor
 *
 * Executes LLM-based hooks using prompt templates.
 * Allows users to define hooks that call an LLM to make decisions
 * about tool execution, user prompts, etc.
 */

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage } from '@langchain/core/messages';
import { logger } from '../utils/logger.js';
import type { HookInput, HookResult } from './types.js';

/**
 * Configuration for prompt hook executor
 */
export interface PromptHookConfig {
	/** LLM API key */
	apiKey: string;

	/** LLM base URL */
	baseUrl?: string;

	/** Model name (default: gpt-3.5-turbo for speed) */
	model?: string;

	/** Request timeout in milliseconds */
	timeout?: number;

	/** Debug mode */
	debug?: boolean;
}

/**
 * Prompt hook executor
 * Uses LLM to evaluate hooks based on prompt templates
 */
export class PromptHookExecutor {
	private llm: ChatOpenAI;
	private config: PromptHookConfig;

	constructor(config: PromptHookConfig) {
		this.config = config;

		// Create LLM instance with fast model for quick hook decisions
		this.llm = new ChatOpenAI({
			apiKey: config.apiKey,
			configuration: {
				...(config.baseUrl && { baseURL: config.baseUrl }),
			},
			modelName: config.model || 'gpt-3.5-turbo', // Fast model for hooks
			temperature: 0, // Deterministic
			timeout: config.timeout || 30000, // 30s default timeout
		});

		if (config.debug) {
			logger.debug('Prompt hook executor initialized');
		}
	}

	/**
	 * Execute a prompt hook
	 *
	 * @param prompt - Prompt template (can contain $ARGUMENTS placeholder)
	 * @param input - Hook input data
	 * @returns Hook result from LLM
	 */
	async execute(prompt: string, input: HookInput): Promise<HookResult> {
		try {
			// Replace placeholders in prompt
			const resolvedPrompt = this.resolvePrompt(prompt, input);

			if (this.config.debug) {
				logger.debug(`Executing prompt hook with template: ${prompt.substring(0, 100)}...`);
			}

			// Call LLM
			const response = await this.llm.invoke([new HumanMessage(resolvedPrompt)]);

			// Parse response
			return this.parseResponse(response.content.toString());
		} catch (error) {
			logger.error(`Prompt hook execution failed: ${error}`);

			// Fail open (allow execution to continue)
			return {
				decision: 'allow',
				reason: `Prompt hook failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	/**
	 * Resolve prompt template by replacing placeholders
	 *
	 * @param prompt - Prompt template
	 * @param input - Hook input data
	 * @returns Resolved prompt
	 */
	private resolvePrompt(prompt: string, input: HookInput): string {
		let resolved = prompt;

		// Replace $ARGUMENTS with full input JSON
		if (resolved.includes('$ARGUMENTS')) {
			const argsJson = JSON.stringify(input, null, 2);
			resolved = resolved.replace(/\$ARGUMENTS/g, argsJson);
		}

		// Replace $TOOL_NAME
		if (resolved.includes('$TOOL_NAME')) {
			resolved = resolved.replace(/\$TOOL_NAME/g, input.tool_name || '');
		}

		// Replace $TOOL_INPUT
		if (resolved.includes('$TOOL_INPUT')) {
			const toolInputJson = JSON.stringify(input.tool_input || {}, null, 2);
			resolved = resolved.replace(/\$TOOL_INPUT/g, toolInputJson);
		}

		// Replace $PROMPT
		if (resolved.includes('$PROMPT')) {
			resolved = resolved.replace(/\$PROMPT/g, input.prompt || '');
		}

		// Replace $SESSION_ID
		if (resolved.includes('$SESSION_ID')) {
			resolved = resolved.replace(/\$SESSION_ID/g, input.session_id);
		}

		// Replace $CWD
		if (resolved.includes('$CWD')) {
			resolved = resolved.replace(/\$CWD/g, input.cwd);
		}

		return resolved;
	}

	/**
	 * Parse LLM response into hook result
	 * Expects JSON response, but handles plain text gracefully
	 *
	 * @param content - LLM response content
	 * @returns Parsed hook result
	 */
	private parseResponse(content: string): HookResult {
		const trimmed = content.trim();

		// Try to parse as JSON
		try {
			const parsed = JSON.parse(trimmed) as HookResult;

			// Validate decision field
			if (parsed.decision) {
				const validDecisions = ['allow', 'deny', 'block', 'approve'];
				if (!validDecisions.includes(parsed.decision)) {
					logger.warn(`Invalid decision from prompt hook: ${parsed.decision}, defaulting to allow`);
					parsed.decision = 'allow';
				}
			} else {
				// Default to allow if no decision
				parsed.decision = 'allow';
			}

			return parsed;
		} catch {
			// Not JSON, treat as plain text reason
			logger.debug('Prompt hook returned plain text, treating as reason');

			// Check for common blocking keywords in response
			const lowerContent = trimmed.toLowerCase();
			const isBlocking =
				lowerContent.includes('block') ||
				lowerContent.includes('deny') ||
				lowerContent.includes('reject') ||
				lowerContent.includes('prevent');

			return {
				decision: isBlocking ? 'deny' : 'allow',
				reason: trimmed,
			};
		}
	}
}
