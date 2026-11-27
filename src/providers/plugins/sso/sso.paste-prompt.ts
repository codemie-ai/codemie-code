/**
 * No-echo paste prompt for headless SSO login.
 *
 * Reads one line from a TTY without echoing it (the pasted value is a credential).
 * Fails fast without a TTY and is bounded by a deadline and an abort signal.
 * Error messages are fixed strings; pasted input is never included.
 */

import { ConfigurationError } from '../../../utils/errors.js';
import { hasInteractiveTerminal, NO_TTY_MESSAGE } from '../../../utils/interactive.js';

export { NO_TTY_MESSAGE };

export interface PasteTokenOptions {
  deadlineMs: number;
  signal?: AbortSignal;
  /** Prompt text written to stdout (default asks for the pasted address/token) */
  message?: string;
}

export const TIMEOUT_MESSAGE = 'Timed out waiting for the pasted login token.';
export const ABORT_MESSAGE = 'Authentication cancelled by user';

/** Largest pasted line accepted. A real token or redirect URL is a few KB at most. */
const MAX_PASTE_LENGTH = 16 * 1024;
const PASTE_TOO_LONG_MESSAGE = 'Pasted input is too long. Copy only the login address and try again.';

/** Fail before touching the terminal: no TTY, or the signal already aborted. */
function assertCanPrompt(signal?: AbortSignal): void {
  if (!hasInteractiveTerminal()) {
    throw new ConfigurationError(NO_TTY_MESSAGE);
  }
  if (signal?.aborted) {
    throw new ConfigurationError(ABORT_MESSAGE);
  }
}

/** Escape sequences (arrow keys, function keys) are CSI `ESC [ ... final` or SS3 `ESC O x`. */
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the purpose of this pattern
const ESCAPE_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|O[@-~])/g;

/**
 * Fold one chunk of terminal input into the paste buffer. Escape sequences are removed first so
 * an arrow key pressed during a paste does not end up in the token. `outcome` is set when the line ends.
 */
function applyChunk(buffer: string, chunk: string): { buffer: string; outcome?: 'abort' | 'submit' | 'too-long' } {
  let next = buffer;
  for (const ch of chunk.replace(ESCAPE_SEQUENCE, '')) {
    if (ch === '\u0003' || ch === '\u0004') return { buffer: next, outcome: 'abort' };
    if (ch === '\r' || ch === '\n') return { buffer: next, outcome: 'submit' };
    if (ch === '\u007f' || ch === '\b') {
      next = next.slice(0, -1);
      continue;
    }
    if (ch < ' ') continue;
    next += ch;
    if (next.length > MAX_PASTE_LENGTH) return { buffer: '', outcome: 'too-long' };
  }
  return { buffer: next };
}

/**
 * Put the terminal into no-echo mode. Returns a function that restores the previous mode.
 * Runs before the timer and abort listener are registered, so a throw here leaves nothing behind.
 * The stream's encoding is never changed: chunks are decoded here, because Node has no API to
 * unset an encoding once set.
 */
function enterRawMode(): () => void {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  return () => {
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      // terminal already gone
    }
  };
}

/**
 * Read one pasted line from the terminal without echoing it.
 *
 * @throws ConfigurationError with NO_TTY_MESSAGE when stdin or stdout is not a TTY,
 *   with ABORT_MESSAGE when the signal is aborted or the user presses Ctrl+C,
 *   with TIMEOUT_MESSAGE when the deadline passes first, and with a fixed message when the
 *   pasted line exceeds MAX_PASTE_LENGTH.
 */
export async function promptForPastedToken(opts: PasteTokenOptions): Promise<string> {
  assertCanPrompt(opts.signal);
  const stdin = process.stdin;
  const wasStarted = stdin.readableFlowing === true;
  const restore = enterRawMode();

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let timer: NodeJS.Timeout | undefined;

    const finish = (done: () => void): void => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      stdin.off('data', onData);
      restore();
      // Pause only when this prompt started the stream; a caller already reading keeps it flowing
      if (!wasStarted) stdin.pause();
      process.stdout.write('\n');
      done();
    };

    const onAbort = (): void => finish(() => reject(new ConfigurationError(ABORT_MESSAGE)));

    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const step = applyChunk(buffer, text);
      buffer = step.buffer;
      if (step.outcome === 'abort') return finish(() => reject(new ConfigurationError(ABORT_MESSAGE)));
      if (step.outcome === 'too-long') return finish(() => reject(new ConfigurationError(PASTE_TOO_LONG_MESSAGE)));
      if (step.outcome === 'submit') return finish(() => resolve(buffer));
    };

    timer = setTimeout(
      () => finish(() => reject(new ConfigurationError(TIMEOUT_MESSAGE))),
      Math.max(0, opts.deadlineMs)
    );
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    process.stdout.write(opts.message ?? 'Paste the address from your browser (input is hidden): ');
    stdin.resume();
    stdin.on('data', onData);
  });
}
