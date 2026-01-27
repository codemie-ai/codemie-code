/**
 * Hook Decision Parser
 *
 * Parses and validates hook output (JSON decisions) and merges results
 * from multiple hooks according to priority rules.
 */

import { logger } from '../utils/logger.js';
import type { HookResult, AggregatedHookResult } from './types.js';

export class DecisionParser {
	/**
	 * Parse JSON output from hook
	 *
	 * @param stdout - Standard output from hook (should be JSON)
	 * @param stderr - Standard error from hook (for logging)
	 * @param exitCode - Exit code from hook process
	 * @returns Parsed hook result or default allow decision
	 */
	static parse(stdout: string, stderr: string, exitCode: number): HookResult {
		// Handle exit code 2 (blocking error - requires agent retry)
		if (exitCode === 2) {
			// Extract feedback from both stderr and stdout for agent to process
			const feedback = [stderr, stdout.trim()].filter(Boolean).join('\n\n');

			return {
				decision: 'block',
				reason: stderr || 'Hook returned blocking error (exit code 2)',
				additionalContext: feedback || undefined,
			};
		}

		// Handle non-zero exit codes (non-blocking errors - informational)
		if (exitCode !== 0) {
			logger.warn(`Hook failed with exit code ${exitCode}: ${stderr}`);

			// Include output as informational feedback for agent
			const feedback = [stderr, stdout.trim()].filter(Boolean).join('\n\n');

			return {
				decision: 'allow',
				reason: `Hook failed but execution continues (exit code ${exitCode})`,
				additionalContext: feedback || undefined,
			};
		}

		// Try to parse JSON output
		const trimmedOutput = stdout.trim();
		if (!trimmedOutput) {
			// Empty output means allow
			return { decision: 'allow' };
		}

		try {
			const result = JSON.parse(trimmedOutput) as HookResult;
			return this.validateResult(result);
		} catch {
			// Not valid JSON - treat as informational output
			logger.debug(`Hook returned non-JSON output, treating as informational`);
			return {
				decision: 'allow',
				additionalContext: trimmedOutput,
			};
		}
	}

	/**
	 * Validate hook result structure
	 *
	 * @param result - Parsed hook result
	 * @returns Validated result (with defaults filled in)
	 */
	static validateResult(result: HookResult): HookResult {
		// Validate decision field
		if (result.decision) {
			const validDecisions = ['allow', 'deny', 'block', 'approve'];
			if (!validDecisions.includes(result.decision)) {
				logger.warn(`Invalid decision value "${result.decision}", defaulting to allow`);
				result.decision = 'allow';
			}
		} else {
			// Default to allow if no decision specified
			result.decision = 'allow';
		}

		// Validate reason field
		if (result.reason && typeof result.reason !== 'string') {
			logger.warn('Invalid reason field (not a string), removing');
			delete result.reason;
		}

		// Validate suppressOutput field
		if (result.suppressOutput !== undefined && typeof result.suppressOutput !== 'boolean') {
			logger.warn('Invalid suppressOutput field (not a boolean), removing');
			delete result.suppressOutput;
		}

		// Validate updatedInput field
		if (result.updatedInput !== undefined && typeof result.updatedInput !== 'object') {
			logger.warn('Invalid updatedInput field (not an object), removing');
			delete result.updatedInput;
		}

		// Validate additionalContext field
		if (result.additionalContext !== undefined && typeof result.additionalContext !== 'string') {
			logger.warn('Invalid additionalContext field (not a string), removing');
			delete result.additionalContext;
		}

		return result;
	}

	/**
	 * Merge results from multiple hooks according to priority rules
	 *
	 * Priority order (highest to lowest):
	 * 1. block - Prevents execution completely
	 * 2. deny - Denies current operation
	 * 3. approve - Explicitly approves
	 * 4. allow - Default, allows execution
	 *
	 * @param results - Array of hook results (from Promise.allSettled)
	 * @returns Aggregated result with highest-priority decision
	 */
	static merge(
		results: PromiseSettledResult<HookResult>[],
	): AggregatedHookResult {
		const aggregated: AggregatedHookResult = {
			decision: 'allow',
			hooksExecuted: results.length,
			hooksSucceeded: 0,
			hooksFailed: 0,
			errors: [],
		};

		// Collect all successful results and errors
		const successfulResults: HookResult[] = [];

		for (const result of results) {
			if (result.status === 'fulfilled') {
				successfulResults.push(result.value);
				aggregated.hooksSucceeded++;
			} else {
				aggregated.hooksFailed++;
				aggregated.errors?.push({
					hook: 'unknown',
					error: result.reason?.message || String(result.reason),
				});
				logger.error(`Hook execution failed: ${result.reason}`);
			}
		}

		// If all hooks failed, return allow (fail open)
		if (successfulResults.length === 0) {
			return aggregated;
		}

		// Apply priority rules to determine final decision
		// Priority: block > deny > approve > allow
		const priorities = {
			block: 4,
			deny: 3,
			approve: 2,
			allow: 1,
		};

		let highestPriority = 0;
		let finalResult: HookResult = { decision: 'allow' };

		for (const result of successfulResults) {
			const priority = priorities[result.decision || 'allow'];
			if (priority > highestPriority) {
				highestPriority = priority;
				finalResult = result;
			}
		}

		// Merge final result into aggregated
		Object.assign(aggregated, finalResult);

		// Collect all additional context from successful hooks
		const contexts = successfulResults
			.map((r) => r.additionalContext)
			.filter((c): c is string => !!c);

		if (contexts.length > 0) {
			aggregated.additionalContext = contexts.join('\n\n');
		}

		// Merge updatedInput from all hooks (later hooks override earlier)
		const updatedInputs = successfulResults
			.map((r) => r.updatedInput)
			.filter((u): u is Record<string, unknown> => !!u);

		if (updatedInputs.length > 0) {
			aggregated.updatedInput = Object.assign({}, ...updatedInputs);
		}

		// Collect reasons from blocking/denying hooks
		const blockingReasons = successfulResults
			.filter((r) => r.decision === 'block' || r.decision === 'deny')
			.map((r) => r.reason)
			.filter((r): r is string => !!r);

		if (blockingReasons.length > 0 && !aggregated.reason) {
			aggregated.reason = blockingReasons.join('; ');
		}

		return aggregated;
	}

	/**
	 * Check if a result is blocking (prevents execution)
	 *
	 * @param result - Hook result to check
	 * @returns true if result blocks execution
	 */
	static isBlocking(result: HookResult): boolean {
		return result.decision === 'block' || result.decision === 'deny';
	}

	/**
	 * Check if an aggregated result is blocking
	 *
	 * @param result - Aggregated hook result
	 * @returns true if any hook blocked execution
	 */
	static isAggregatedBlocking(result: AggregatedHookResult): boolean {
		return this.isBlocking(result);
	}
}
