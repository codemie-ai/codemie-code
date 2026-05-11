import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../logger.js';

describe('logger', () => {
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

  it('prints structured error objects instead of object placeholders', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logger.error('Assistant chat API call failed', {
      error: {
        detail: 'Confluence credential is missing'
      },
      statusCode: 500
    });

    const output = consoleError.mock.calls.map(call => call.join(' ')).join('\n');

    expect(output).toContain('Assistant chat API call failed');
    expect(output).toContain('Confluence credential is missing');
    expect(output).not.toContain('[object Object]');
  });
});
