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

describe('canPromptForProject (EPMCDME-15411)', () => {
  const stdinTTY = process.stdin.isTTY;
  const stdoutTTY = process.stdout.isTTY;
  const noPrompts = process.env.CODEMIE_NO_PROMPTS;

  afterEach(() => {
    process.stdin.isTTY = stdinTTY;
    process.stdout.isTTY = stdoutTTY;
    if (noPrompts === undefined) delete process.env.CODEMIE_NO_PROMPTS;
    else process.env.CODEMIE_NO_PROMPTS = noPrompts;
  });

  it('allows the prompt only with a TTY on stdin and stdout, no --task and no CODEMIE_NO_PROMPTS', async () => {
    const { canPromptForProject } = await import('../interactive.js');
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    delete process.env.CODEMIE_NO_PROMPTS;
    expect(canPromptForProject()).toBe(true);
    expect(canPromptForProject({ task: 'do it' })).toBe(false);

    process.env.CODEMIE_NO_PROMPTS = '1';
    expect(canPromptForProject()).toBe(false);
    delete process.env.CODEMIE_NO_PROMPTS;

    process.stdout.isTTY = false as unknown as true;
    expect(canPromptForProject()).toBe(false);
    process.stdout.isTTY = true;
    process.stdin.isTTY = undefined as unknown as true;
    expect(canPromptForProject()).toBe(false);
  });
});
