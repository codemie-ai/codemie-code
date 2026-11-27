/**
 * @group unit
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { promptForPastedToken, TIMEOUT_MESSAGE } from '../sso.paste-prompt.js';
import { NO_TTY_MESSAGE } from '../../../../utils/interactive.js';

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

describe('promptForPastedToken hardening', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setTTY(false, false);
  });

  function stubStdin(): { setRaw: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
    setTTY(true, true);
    const setRaw = vi.fn();
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRaw, configurable: true });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    return { setRaw, write };
  }

  it('strips arrow-key escape sequences from the pasted token', async () => {
    stubStdin();
    const p = promptForPastedToken({ deadlineMs: 1000 });
    process.stdin.emit('data', 'abc\u001b[A123\r');
    await expect(p).resolves.toBe('abc123');
  });

  it('rejects a pasted line over the size cap with a fixed message', async () => {
    stubStdin();
    const p = promptForPastedToken({ deadlineMs: 1000 });
    process.stdin.emit('data', 'x'.repeat(16 * 1024 + 1));
    await expect(p).rejects.toThrow(/too long/);
  });

  it('leaves no timer behind when raw mode cannot be set', async () => {
    setTTY(true, true);
    Object.defineProperty(process.stdin, 'setRawMode', {
      value: () => { throw new Error('raw mode unsupported'); },
      configurable: true,
    });
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const on = vi.spyOn(process.stdin, 'on');

    await expect(promptForPastedToken({ deadlineMs: 1000 })).rejects.toThrow('raw mode unsupported');
    expect(on).not.toHaveBeenCalledWith('data', expect.any(Function));
    expect(clear).not.toHaveBeenCalled();
  });

  it('does not change the stream encoding or pause a stream the caller already reads', async () => {
    const { setRaw } = stubStdin();
    Object.defineProperty(process.stdin, 'readableFlowing', { value: true, configurable: true });
    const setEncoding = vi.spyOn(process.stdin, 'setEncoding');
    const pause = vi.spyOn(process.stdin, 'pause');

    const p = promptForPastedToken({ deadlineMs: 1000 });
    process.stdin.emit('data', 'tok\r');
    await p;

    expect(setEncoding).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(setRaw).toHaveBeenLastCalledWith(false);
    Object.defineProperty(process.stdin, 'readableFlowing', { value: null, configurable: true });
  });
});
