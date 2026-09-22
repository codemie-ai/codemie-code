import { describe, it, expect, vi } from 'vitest';
import { PartialRegistrationError } from '@/utils/errors.js';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    getLogFilePath: vi.fn(),
  },
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    clear: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
  })),
}));

describe('executeWithSpinnerStrict', () => {
  it('resolves with the operation result on success', async () => {
    const { executeWithSpinnerStrict } = await import('../helpers.js');

    const result = await executeWithSpinnerStrict(
      'Working...',
      async () => 'ok',
      'Success',
      'Failure'
    );

    expect(result).toBe('ok');
  });

  it('rethrows the original error after stopping the spinner and still calls onError', async () => {
    const { executeWithSpinnerStrict } = await import('../helpers.js');
    const originalError = new Error('write failed');
    const onError = vi.fn();

    await expect(
      executeWithSpinnerStrict(
        'Working...',
        async () => {
          throw originalError;
        },
        'Success',
        'Failure',
        onError
      )
    ).rejects.toBe(originalError);

    expect(onError).toHaveBeenCalledWith(originalError);
  });

  it('still rethrows the original error when no onError handler is passed', async () => {
    const { executeWithSpinnerStrict } = await import('../helpers.js');
    const originalError = new Error('write failed, no handler');

    await expect(
      executeWithSpinnerStrict(
        'Working...',
        async () => {
          throw originalError;
        },
        'Success',
        'Failure'
      )
    ).rejects.toBe(originalError);
  });
});

describe('registerAllOrAbort', () => {
  it('returns all results in order for an all-success batch', async () => {
    const { registerAllOrAbort } = await import('../helpers.js');

    const items = ['a', 'b', 'c'];
    const writeOne = vi.fn(async (item: string) => `${item}-written`);

    const results = await registerAllOrAbort(items, (item) => item, writeOne);

    expect(results).toEqual(['a-written', 'b-written', 'c-written']);
    expect(writeOne).toHaveBeenCalledTimes(3);
  });

  it('stops at the first rejection and throws PartialRegistrationError naming only the items already written', async () => {
    const { registerAllOrAbort } = await import('../helpers.js');

    const items = ['first', 'second', 'third'];
    const failure = new Error('boom');
    const writeOne = vi.fn(async (item: string) => {
      if (item === 'third') {
        throw failure;
      }
      return `${item}-written`;
    });

    const error: unknown = await registerAllOrAbort(items, (item) => item, writeOne).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(PartialRegistrationError);
    const partialError = error as PartialRegistrationError;
    expect(partialError.written).toEqual(['first', 'second']);
    expect(partialError.cause).toBe(failure);
    expect(writeOne).toHaveBeenCalledTimes(3);
  });

  it('writes sequentially, not concurrently', async () => {
    const { registerAllOrAbort } = await import('../helpers.js');

    const items = ['a', 'b', 'c'];
    const inFlight: string[] = [];
    const maxConcurrent: number[] = [];
    const writeOne = vi.fn(async (item: string) => {
      inFlight.push(item);
      maxConcurrent.push(inFlight.length);
      await Promise.resolve();
      inFlight.pop();
      return item;
    });

    await registerAllOrAbort(items, (item) => item, writeOne);

    expect(Math.max(...maxConcurrent)).toBe(1);
  });
});

describe('persistPartialWrites', () => {
  it('saves the already-written items alongside the untouched ones', async () => {
    const { persistPartialWrites } = await import('../helpers.js');
    const save = vi.fn(async () => {});

    await persistPartialWrites([{ id: 'written' }], [{ id: 'untouched' }], save);

    expect(save).toHaveBeenCalledWith([{ id: 'untouched' }, { id: 'written' }]);
  });

  it('does not save at all when nothing was written', async () => {
    const { persistPartialWrites } = await import('../helpers.js');
    const save = vi.fn(async () => {});

    await persistPartialWrites([], [{ id: 'untouched' }], save);

    expect(save).not.toHaveBeenCalled();
  });

  it('swallows a save failure so it cannot mask the original registration error', async () => {
    const { persistPartialWrites } = await import('../helpers.js');
    const save = vi.fn(async () => {
      throw new Error('config write failed');
    });

    await expect(persistPartialWrites([{ id: 'written' }], [], save)).resolves.toBeUndefined();
  });
});
