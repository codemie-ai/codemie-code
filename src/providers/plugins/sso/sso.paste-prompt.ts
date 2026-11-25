/**
 * No-echo paste prompt for headless SSO login.
 *
 * Reads one line from a TTY without echoing it (the pasted value is a credential).
 * Fails fast without a TTY and is bounded by a deadline and an abort signal.
 * Error messages are fixed strings; pasted input is never included.
 */

import { ConfigurationError } from '../../../utils/errors.js';

export interface PasteTokenOptions {
  deadlineMs: number;
  signal?: AbortSignal;
  /** Prompt text written to stdout (default asks for the pasted address/token) */
  message?: string;
}

export const NO_TTY_MESSAGE =
  'Headless login needs an interactive terminal (stdin and stdout must both be a TTY).';
export const TIMEOUT_MESSAGE = 'Timed out waiting for the pasted login token.';
export const ABORT_MESSAGE = 'Authentication cancelled by user';

/** Fail before touching the terminal: no TTY, or the signal already aborted. */
function assertCanPrompt(signal?: AbortSignal): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigurationError(NO_TTY_MESSAGE);
  }
  if (signal?.aborted) {
    throw new ConfigurationError(ABORT_MESSAGE);
  }
}

/** Fold one keystroke into the paste buffer; `outcome` is set when the line ends. */
function applyKey(buffer: string, ch: string): { buffer: string; outcome?: 'abort' | 'submit' } {
  if (ch === '\u0003' || ch === '\u0004') return { buffer, outcome: 'abort' };
  if (ch === '\r' || ch === '\n') return { buffer, outcome: 'submit' };
  if (ch === '\u007f' || ch === '\b') return { buffer: buffer.slice(0, -1) };
  return { buffer: ch >= ' ' ? buffer + ch : buffer };
}

/**
 * Read one pasted line from the terminal without echoing it.
 *
 * @throws ConfigurationError with NO_TTY_MESSAGE when stdin or stdout is not a TTY,
 *   with ABORT_MESSAGE when the signal is aborted or the user presses Ctrl+C,
 *   and with TIMEOUT_MESSAGE when the deadline passes first.
 */
export async function promptForPastedToken(opts: PasteTokenOptions): Promise<string> {
  assertCanPrompt(opts.signal);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let timer: NodeJS.Timeout | undefined;

    const finish = (done: () => void): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw ?? false);
      } catch {
        // terminal already gone
      }
      stdin.pause();
      process.stdout.write('\n');
      done();
    };

    const onAbort = (): void => finish(() => reject(new ConfigurationError(ABORT_MESSAGE)));

    const onData = (chunk: Buffer | string): void => {
      for (const ch of chunk.toString('utf8')) {
        const step = applyKey(buffer, ch);
        buffer = step.buffer;
        if (step.outcome === 'abort') return finish(() => reject(new ConfigurationError(ABORT_MESSAGE)));
        if (step.outcome === 'submit') return finish(() => resolve(buffer));
      }
    };

    timer = setTimeout(
      () => finish(() => reject(new ConfigurationError(TIMEOUT_MESSAGE))),
      Math.max(0, opts.deadlineMs)
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    process.stdout.write(opts.message ?? 'Paste the address from your browser (input is hidden): ');
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}
