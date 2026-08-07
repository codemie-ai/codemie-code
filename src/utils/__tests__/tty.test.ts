import { describe, it, expect, afterEach, beforeEach } from 'vitest';

describe('isInteractive', () => {
  let originalIsTTY: boolean | undefined;
  let originalNoPrompts: string | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY;
    originalNoPrompts = process.env.CODEMIE_NO_PROMPTS;
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    if (originalNoPrompts === undefined) {
      delete process.env.CODEMIE_NO_PROMPTS;
    } else {
      process.env.CODEMIE_NO_PROMPTS = originalNoPrompts;
    }
  });

  it('returns true when TTY and CODEMIE_NO_PROMPTS unset', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env.CODEMIE_NO_PROMPTS;
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(true);
  });

  it('returns false when non-TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    delete process.env.CODEMIE_NO_PROMPTS;
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(false);
  });

  it('returns false when CODEMIE_NO_PROMPTS=1 even on TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.env.CODEMIE_NO_PROMPTS = '1';
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(false);
  });

  it('returns false when process.stdin.isTTY is undefined', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    delete process.env.CODEMIE_NO_PROMPTS;
    const { isInteractive } = await import('../tty.js');
    expect(isInteractive()).toBe(false);
  });
});
