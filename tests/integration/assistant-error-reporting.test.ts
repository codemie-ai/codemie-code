import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from 'codemie-sdk';
import { createErrorContext, formatErrorForUser } from '../../src/utils/errors.js';
import { logger } from '../../src/utils/logger.js';

describe('Assistant API error reporting integration', () => {
  const originalDebug = process.env.CODEMIE_DEBUG;

  beforeEach(() => {
    process.env.CODEMIE_DEBUG = 'true';
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.CODEMIE_DEBUG;
    } else {
      process.env.CODEMIE_DEBUG = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it('surfaces SDK response details through formatting and verbose logging', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new ApiError('', 500, {
      error: {
        detail: 'Confluence credential is missing'
      }
    });

    const context = createErrorContext(error);
    const formatted = formatErrorForUser(context, { showSystem: false });
    logger.error('Assistant chat API call failed', context);

    const verboseOutput = consoleError.mock.calls.map(call => call.join(' ')).join('\n');

    expect(formatted).toContain('Confluence credential is missing');
    expect(verboseOutput).toContain('Confluence credential is missing');
    expect(verboseOutput).not.toContain('[object Object]');
  });
});
