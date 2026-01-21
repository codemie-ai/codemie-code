/**
 * Tests for DecisionParser
 */

import { describe, it, expect } from 'vitest';
import { DecisionParser } from '../decision.js';
import type { HookResult } from '../types.js';

describe('DecisionParser', () => {
	describe('parse', () => {
		it('should parse exit code 2 as blocking error', () => {
			const result = DecisionParser.parse('', 'Error occurred', 2);
			expect(result.decision).toBe('block');
			expect(result.reason).toBe('Error occurred');
		});

		it('should parse exit code 2 with default reason', () => {
			const result = DecisionParser.parse('', '', 2);
			expect(result.decision).toBe('block');
			expect(result.reason).toBe('Hook returned blocking error (exit code 2)');
		});

		it('should parse non-zero exit code as allow', () => {
			const result = DecisionParser.parse('', 'Non-blocking error', 1);
			expect(result.decision).toBe('allow');
			expect(result.reason).toContain('Hook failed but execution continues');
		});

		it('should parse valid JSON output', () => {
			const json = JSON.stringify({ decision: 'deny', reason: 'Test reason' });
			const result = DecisionParser.parse(json, '', 0);
			expect(result.decision).toBe('deny');
			expect(result.reason).toBe('Test reason');
		});

		it('should parse empty output as allow', () => {
			const result = DecisionParser.parse('', '', 0);
			expect(result.decision).toBe('allow');
		});

		it('should handle invalid JSON as allow', () => {
			const result = DecisionParser.parse('not json', '', 0);
			expect(result.decision).toBe('allow');
			expect(result.additionalContext).toBe('not json');
		});
	});

	describe('validateResult', () => {
		it('should validate and set default decision', () => {
			const result = DecisionParser.validateResult({});
			expect(result.decision).toBe('allow');
		});

		it('should reject invalid decision values', () => {
			const result = DecisionParser.validateResult({ decision: 'invalid' as any });
			expect(result.decision).toBe('allow');
		});

		it('should accept valid decision values', () => {
			expect(DecisionParser.validateResult({ decision: 'allow' }).decision).toBe('allow');
			expect(DecisionParser.validateResult({ decision: 'deny' }).decision).toBe('deny');
			expect(DecisionParser.validateResult({ decision: 'block' }).decision).toBe('block');
			expect(DecisionParser.validateResult({ decision: 'approve' }).decision).toBe('approve');
		});

		it('should remove invalid reason field', () => {
			const result = DecisionParser.validateResult({ reason: 123 as any });
			expect(result.reason).toBeUndefined();
		});

		it('should remove invalid suppressOutput field', () => {
			const result = DecisionParser.validateResult({ suppressOutput: 'yes' as any });
			expect(result.suppressOutput).toBeUndefined();
		});

		it('should remove invalid updatedInput field', () => {
			const result = DecisionParser.validateResult({ updatedInput: 'not object' as any });
			expect(result.updatedInput).toBeUndefined();
		});
	});

	describe('merge', () => {
		it('should merge multiple successful results with block priority', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'fulfilled', value: { decision: 'allow' } },
				{ status: 'fulfilled', value: { decision: 'block', reason: 'Blocked' } },
				{ status: 'fulfilled', value: { decision: 'deny' } },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.decision).toBe('block');
			expect(merged.reason).toBe('Blocked');
			expect(merged.hooksExecuted).toBe(3);
			expect(merged.hooksSucceeded).toBe(3);
			expect(merged.hooksFailed).toBe(0);
		});

		it('should prioritize deny over approve', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'fulfilled', value: { decision: 'allow' } },
				{ status: 'fulfilled', value: { decision: 'deny', reason: 'Denied' } },
				{ status: 'fulfilled', value: { decision: 'approve' } },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.decision).toBe('deny');
			expect(merged.reason).toBe('Denied');
		});

		it('should prioritize approve over allow', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'fulfilled', value: { decision: 'allow' } },
				{ status: 'fulfilled', value: { decision: 'approve', reason: 'Approved' } },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.decision).toBe('approve');
			expect(merged.reason).toBe('Approved');
		});

		it('should handle all failed hooks', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'rejected', reason: new Error('Hook 1 failed') },
				{ status: 'rejected', reason: new Error('Hook 2 failed') },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.decision).toBe('allow'); // Fail open
			expect(merged.hooksExecuted).toBe(2);
			expect(merged.hooksSucceeded).toBe(0);
			expect(merged.hooksFailed).toBe(2);
			expect(merged.errors?.length).toBe(2);
		});

		it('should merge additional context from multiple hooks', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'fulfilled', value: { decision: 'allow', additionalContext: 'Context 1' } },
				{ status: 'fulfilled', value: { decision: 'allow', additionalContext: 'Context 2' } },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.additionalContext).toBe('Context 1\n\nContext 2');
		});

		it('should merge updatedInput from multiple hooks', () => {
			const results: PromiseSettledResult<HookResult>[] = [
				{ status: 'fulfilled', value: { decision: 'allow', updatedInput: { a: 1 } } },
				{ status: 'fulfilled', value: { decision: 'allow', updatedInput: { b: 2, a: 3 } } },
			];

			const merged = DecisionParser.merge(results);
			expect(merged.updatedInput).toEqual({ a: 3, b: 2 }); // Later hooks override
		});
	});

	describe('isBlocking', () => {
		it('should detect blocking decisions', () => {
			expect(DecisionParser.isBlocking({ decision: 'block' })).toBe(true);
			expect(DecisionParser.isBlocking({ decision: 'deny' })).toBe(true);
		});

		it('should detect non-blocking decisions', () => {
			expect(DecisionParser.isBlocking({ decision: 'allow' })).toBe(false);
			expect(DecisionParser.isBlocking({ decision: 'approve' })).toBe(false);
		});
	});

	describe('isAggregatedBlocking', () => {
		it('should detect blocking aggregated results', () => {
			const result = {
				decision: 'block' as const,
				hooksExecuted: 1,
				hooksSucceeded: 1,
				hooksFailed: 0,
			};
			expect(DecisionParser.isAggregatedBlocking(result)).toBe(true);
		});

		it('should detect non-blocking aggregated results', () => {
			const result = {
				decision: 'allow' as const,
				hooksExecuted: 1,
				hooksSucceeded: 1,
				hooksFailed: 0,
			};
			expect(DecisionParser.isAggregatedBlocking(result)).toBe(false);
		});
	});
});
