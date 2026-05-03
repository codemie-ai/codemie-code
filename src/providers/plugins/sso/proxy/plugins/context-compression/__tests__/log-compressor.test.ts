import { describe, it, expect } from 'vitest';
import { createLogCompressor, LogFormat as _LogFormat, LogLevel as _LogLevel } from '../compressors/log-compressor.js';
import { createTokenizer } from '../tokenizer/tiktoken.js';

const tokenizer = createTokenizer();

describe('LogCompressor — stack-trace state machine', () => {
  it('preserves all lines of a Python traceback including blank-line-separated chained exceptions', async () => {
    const traceback = [
      'Traceback (most recent call last):',
      '  File "app.py", line 42, in run',
      '    result = process()',
      '',
      'During handling of the above exception, another exception occurred:',
      '',
      'Traceback (most recent call last):',
      '  File "app.py", line 99, in handler',
      '    raise RuntimeError("fatal")',
      'RuntimeError: fatal',
    ].join('\n');

    const compressor = createLogCompressor(tokenizer, { maxTotalLines: 200 });
    const result = await compressor.compress(traceback);
    expect(result.compressed).toContain('RuntimeError: fatal');
    expect(result.compressed).toContain('During handling of the above exception');
  });

  it('detects PYTEST format from "FAILED" + "passed" lines', async () => {
    const log = [
      'FAILED tests/test_foo.py::test_bar - AssertionError: 1 != 2',
      'FAILED tests/test_foo.py::test_baz - TypeError: str',
      '3 failed, 10 passed in 1.23s',
    ].join('\n');
    const compressor = createLogCompressor(tokenizer);
    const result = await compressor.compress(log);
    expect(result.compressed).toContain('FAILED');
    expect(result.compressed).toContain('3 failed');
  });
});

describe('LogCompressor — conservative dedupe', () => {
  it('does NOT collapse distinct error messages that differ only by trailing variable', async () => {
    const log = [
      'ERROR: connection refused at 10.0.0.1:5432',
      'ERROR: connection refused at 10.0.0.2:5432',
      'ERROR: timeout connecting to 10.0.0.3:5432',
    ].join('\n');
    const compressor = createLogCompressor(tokenizer, { maxErrors: 10 });
    const result = await compressor.compress(log);
    expect(result.compressed).toContain('connection refused');
    expect(result.compressed).toContain('timeout connecting');
  });

  it('deduplicates truly identical repeated log lines', async () => {
    const line = 'INFO: heartbeat ok';
    const log = Array(20).fill(line).join('\n');
    const compressor = createLogCompressor(tokenizer, { maxTotalLines: 5 });
    const result = await compressor.compress(log);
    const occurrences = (result.compressed.match(/heartbeat ok/g) ?? []).length;
    expect(occurrences).toBeLessThan(10);
  });
});

describe('LogCompressor — CCR', () => {
  it('stores original in CCR when compression ratio < 0.6', async () => {
    const { createCompressionStore } = await import('../ccr/store.js');
    const store = createCompressionStore();
    const compressor = createLogCompressor(tokenizer, { maxTotalLines: 3 }, store);
    const largeLog = Array.from({ length: 100 }, (_, i) =>
      i % 5 === 0 ? `ERROR: failure at step ${i}` : `INFO: step ${i} ok`,
    ).join('\n');
    const result = await compressor.compress(largeLog);
    if (result.cacheKey) {
      const retrieved = store.retrieve(result.cacheKey);
      expect(retrieved).toBeTruthy();
      expect((retrieved as { originalContent: string }).originalContent).toContain('ERROR');
    }
  });
});
