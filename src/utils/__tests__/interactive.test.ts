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
