import { describe, it, expect, afterEach } from 'vitest';

describe('isNonInteractiveEnvironment', () => {
  const originalIsTTY = process.stdin.isTTY;

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should return true when process.stdin.isTTY is undefined (no TTY, e.g. piped/CI)', async () => {
    process.stdin.isTTY = undefined as unknown as true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(true);
  });

  it('should return true when process.stdin.isTTY is false', async () => {
    process.stdin.isTTY = false as unknown as true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(true);
  });

  it('should return false when process.stdin.isTTY is true (interactive terminal)', async () => {
    process.stdin.isTTY = true;

    const { isNonInteractiveEnvironment } = await import('../interactive.js');

    expect(isNonInteractiveEnvironment()).toBe(false);
  });
});

describe('isNonInteractiveOutput', () => {
  const originalStdin = process.stdin.isTTY;
  const originalStderr = process.stderr.isTTY;

  afterEach(() => {
    process.stdin.isTTY = originalStdin;
    process.stderr.isTTY = originalStderr;
  });



  // Input and output redirect independently — the two must be able to disagree.
  it('should track stderr, not stdin, when only stdin is redirected', async () => {
    process.stdin.isTTY = false as unknown as true;
    process.stderr.isTTY = true;

    const { isNonInteractiveOutput, isNonInteractiveEnvironment } = await import(
      '../interactive.js'
    );

    expect(isNonInteractiveEnvironment()).toBe(true);
    expect(isNonInteractiveOutput()).toBe(false);
  });

  it('should track stderr, not stdin, when only output is redirected', async () => {
    process.stdin.isTTY = true;
    process.stderr.isTTY = undefined as unknown as true;

    const { isNonInteractiveOutput, isNonInteractiveEnvironment } = await import(
      '../interactive.js'
    );

    expect(isNonInteractiveEnvironment()).toBe(false);
    expect(isNonInteractiveOutput()).toBe(true);
  });
});
