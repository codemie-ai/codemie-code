import { describe, expect, it } from 'vitest';
import { ApiError } from 'codemie-sdk';
import { createErrorContext, formatErrorForUser } from '../errors.js';

describe('error formatting', () => {
  it('formats empty error messages without throwing', () => {
    const context = createErrorContext(new Error(''));

    const formatted = formatErrorForUser(context, { showSystem: false });

    expect(formatted).toContain('❌ Error');
    expect(formatted).toContain('Timestamp:');
  });

  it('uses SDK ApiError response details when the message is empty', () => {
    const error = new ApiError('', 500, {
      error: {
        detail: 'Confluence credential is missing'
      }
    });

    const context = createErrorContext(error);
    const formatted = formatErrorForUser(context, { showSystem: false });

    expect(formatted).toContain('Confluence credential is missing');
  });

  it('handles circular nested error objects without recursing forever', () => {
    const circular: Record<string, unknown> = {};
    circular.error = circular;

    const context = createErrorContext(circular);
    const formatted = formatErrorForUser(context, { showSystem: false });

    expect(formatted).toContain('Error object: error');
  });
});
