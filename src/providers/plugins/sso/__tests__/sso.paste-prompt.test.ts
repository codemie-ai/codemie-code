/**
 * @group unit
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptForPastedToken, NO_TTY_MESSAGE, TIMEOUT_MESSAGE } from '../sso.paste-prompt.js';

function setTTY(stdin: boolean, stdout: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: stdin, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: stdout, configurable: true });
}

describe('promptForPastedToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setTTY(false, false);
  });

  it.each([[false, true], [true, false], [false, false]])(
    'rejects immediately without a TTY (stdin=%s stdout=%s)',
    async (i, o) => {
      setTTY(i, o);
      await expect(promptForPastedToken({ deadlineMs: 1000 })).rejects.toThrow(NO_TTY_MESSAGE);
    }
  );

  it('times out with no input and restores raw mode', async () => {
    setTTY(true, true);
    const setRaw = vi.fn();
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRaw, configurable: true });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);

    await expect(promptForPastedToken({ deadlineMs: 20 })).rejects.toThrow(TIMEOUT_MESSAGE);

    expect(setRaw).toHaveBeenNthCalledWith(1, true);
    expect(setRaw).toHaveBeenLastCalledWith(false);
  });

  it('resolves with the typed line without echoing it', async () => {
    setTTY(true, true);
    Object.defineProperty(process.stdin, 'setRawMode', { value: vi.fn(), configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);

    const p = promptForPastedToken({ deadlineMs: 1000 });
    process.stdin.emit('data', 'abc123\r');

    await expect(p).resolves.toBe('abc123');
    expect(write.mock.calls.some(c => String(c[0]).includes('abc123'))).toBe(false);
  });
});
