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

export async function promptForPastedToken(opts: PasteTokenOptions): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigurationError(NO_TTY_MESSAGE);
  }
  if (opts.signal?.aborted) {
    throw new ConfigurationError(ABORT_MESSAGE);
  }

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
        if (ch === '\u0003' || ch === '\u0004') {
          return finish(() => reject(new ConfigurationError(ABORT_MESSAGE)));
        }
        if (ch === '\r' || ch === '\n') {
          return finish(() => resolve(buffer));
        }
        if (ch === '\u007f' || ch === '\b') {
          buffer = buffer.slice(0, -1);
        } else if (ch >= ' ') {
          buffer += ch;
        }
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
