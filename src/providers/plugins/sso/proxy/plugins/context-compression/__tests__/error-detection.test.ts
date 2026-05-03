import { describe, it, expect } from 'vitest';
import {
  ERROR_KEYWORDS,
  WARNING_KEYWORDS,
  IMPORTANCE_KEYWORDS,
  SECURITY_KEYWORDS,
  ERROR_PATTERN,
  WARNING_PATTERN,
  IMPORTANCE_PATTERN,
  SECURITY_PATTERN,
  PRIORITY_PATTERNS_DIFF,
  PRIORITY_PATTERNS_SEARCH,
  contentHasErrorIndicators,
  scoreLine,
} from '../compressors/error-detection.js';

describe('ERROR_KEYWORDS', () => {
  it('contains core error words', () => {
    expect(ERROR_KEYWORDS.has('error')).toBe(true);
    expect(ERROR_KEYWORDS.has('exception')).toBe(true);
    expect(ERROR_KEYWORDS.has('fatal')).toBe(true);
    expect(ERROR_KEYWORDS.has('traceback')).toBe(true);
  });

  it('contains timeout/abort/denied/rejected (bug fix)', () => {
    expect(ERROR_KEYWORDS.has('timeout')).toBe(true);
    expect(ERROR_KEYWORDS.has('abort')).toBe(true);
    expect(ERROR_KEYWORDS.has('denied')).toBe(true);
    expect(ERROR_KEYWORDS.has('rejected')).toBe(true);
  });
});

describe('SECURITY_KEYWORDS', () => {
  it('does NOT contain "token" (false-positive fix)', () => {
    expect(SECURITY_KEYWORDS.has('token')).toBe(false);
  });

  it('contains api_key, secret, password', () => {
    expect(SECURITY_KEYWORDS.has('api_key')).toBe(true);
    expect(SECURITY_KEYWORDS.has('secret')).toBe(true);
    expect(SECURITY_KEYWORDS.has('password')).toBe(true);
  });
});

describe('ERROR_PATTERN', () => {
  it('matches timeout in line', () => {
    expect(ERROR_PATTERN.test('FATAL: timeout connecting upstream')).toBe(true);
  });

  it('matches abort', () => {
    expect(ERROR_PATTERN.test('Process abort: signal 11')).toBe(true);
  });

  it('matches denied', () => {
    expect(ERROR_PATTERN.test('Access denied: forbidden')).toBe(true);
  });

  it('matches rejected', () => {
    expect(ERROR_PATTERN.test('Connection rejected by server')).toBe(true);
  });

  it('matches classic error/fail/exception/traceback/stacktrace/critical', () => {
    for (const word of ['error', 'failed', 'exception', 'traceback', 'stacktrace', 'critical']) {
      expect(ERROR_PATTERN.test(word)).toBe(true);
    }
  });
});

describe('contentHasErrorIndicators', () => {
  it('returns true for text containing error keyword', () => {
    expect(contentHasErrorIndicators('NullPointerException at line 42')).toBe(true);
  });

  it('returns false for benign text', () => {
    expect(contentHasErrorIndicators('All tests passed successfully')).toBe(false);
  });

  it('does not false-positive on "input_tokens"', () => {
    expect(contentHasErrorIndicators('tokens_saved=1500 input_tokens=3000')).toBe(false);
  });
});

describe('scoreLine', () => {
  it('returns error category for error line', () => {
    const [category, priority] = scoreLine('ERROR: file not found', 'text');
    expect(category).toBe('error');
    expect(priority).toBeGreaterThan(0.5);
  });

  it('returns null category for neutral line', () => {
    const [category] = scoreLine('const x = 42;', 'text');
    expect(category).toBeNull();
  });

  it('returns warning category for WARN prefix', () => {
    const [category] = scoreLine('WARN: deprecated API call', 'text');
    expect(category).toBe('warning');
  });

  it('returns security category for api_key line', () => {
    const [category] = scoreLine('api_key=abc123', 'text');
    expect(category).toBe('security');
  });
});

describe('WARNING_KEYWORDS', () => {
  it('contains core warning words', () => {
    expect(WARNING_KEYWORDS.has('warning')).toBe(true);
    expect(WARNING_KEYWORDS.has('warn')).toBe(true);
    expect(WARNING_KEYWORDS.has('deprecated')).toBe(true);
  });
});

describe('IMPORTANCE_KEYWORDS', () => {
  it('contains core importance words', () => {
    expect(IMPORTANCE_KEYWORDS.has('important')).toBe(true);
    expect(IMPORTANCE_KEYWORDS.has('todo')).toBe(true);
    expect(IMPORTANCE_KEYWORDS.has('fixme')).toBe(true);
  });
});

describe('WARNING_PATTERN', () => {
  it('matches warn in line', () => {
    expect(WARNING_PATTERN.test('WARN: disk space low')).toBe(true);
  });

  it('does not match unrelated text', () => {
    expect(WARNING_PATTERN.test('all systems nominal')).toBe(false);
  });
});

describe('IMPORTANCE_PATTERN', () => {
  it('matches todo in line', () => {
    expect(IMPORTANCE_PATTERN.test('TODO: refactor this')).toBe(true);
  });
});

describe('SECURITY_PATTERN', () => {
  it('matches api_key in line', () => {
    expect(SECURITY_PATTERN.test('api_key=supersecret')).toBe(true);
  });

  it('matches password in line', () => {
    expect(SECURITY_PATTERN.test('password=hunter2')).toBe(true);
  });

  it('does NOT match bare "token" (false-positive fix)', () => {
    expect(SECURITY_PATTERN.test('input_tokens=3000')).toBe(false);
  });
});

describe('PRIORITY_PATTERNS_DIFF and PRIORITY_PATTERNS_SEARCH', () => {
  it('PRIORITY_PATTERNS_DIFF contains compiled RegExp entries', () => {
    expect(PRIORITY_PATTERNS_DIFF.length).toBeGreaterThan(0);
    expect(PRIORITY_PATTERNS_DIFF[0].pattern).toBeInstanceOf(RegExp);
    expect(typeof PRIORITY_PATTERNS_DIFF[0].weight).toBe('number');
  });

  it('PRIORITY_PATTERNS_SEARCH contains compiled RegExp entries', () => {
    expect(PRIORITY_PATTERNS_SEARCH.length).toBeGreaterThan(0);
    expect(PRIORITY_PATTERNS_SEARCH[0].pattern).toBeInstanceOf(RegExp);
  });
});
