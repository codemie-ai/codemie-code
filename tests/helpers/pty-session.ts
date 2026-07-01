import * as pty from 'node-pty';

// Strips common ANSI/VT100 escape sequences so pattern matching works on plain text.
const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][012AB]|\x1b[=>]|\x07|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g; // eslint-disable-line no-control-regex

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export interface PtySession {
  writeLine(text: string): void;
  /** Send raw bytes to the PTY without appending \r (use for control characters like \x03). */
  write(raw: string): void;
  waitFor(pattern: RegExp, timeoutMs: number, startFromLine?: number): Promise<string>;
  /** Wait for the process to exit naturally, force-kill after timeoutMs. */
  exit(timeoutMs?: number): Promise<void>;
  /** Return a snapshot of all lines received from the PTY so far. */
  lines(): string[];
}

interface Waiter {
  pattern: RegExp;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function spawnPty(
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): PtySession {
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: options.cwd,
    env: options.env,
  });

  const allLines: string[] = [];
  const waiters: Waiter[] = [];
  let tail = '';

  proc.onData((raw) => {
    const chunk = stripAnsi(raw);
    tail += chunk;
    const parts = tail.split(/\r?\n/);
    tail = parts.pop() ?? '';
    const newLines = parts.map((l) => l.replace(/\r/g, '').trim()).filter((l) => l.length > 0);
    allLines.push(...newLines);
    for (const line of newLines) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pattern.test(line)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(line);
        }
      }
    }
    // Also check the incomplete current line (input prompts never emit a trailing \n
    // while waiting for user input, so they never appear in allLines).
    const trimmedTail = tail.replace(/\r/g, '').trim();
    if (trimmedTail.length > 0) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pattern.test(trimmedTail)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(trimmedTail);
        }
      }
    }
  });

  return {
    writeLine(text: string): void {
      proc.write(text + '\r\n');
    },

    write(raw: string): void {
      proc.write(raw);
    },

    waitFor(pattern: RegExp, timeoutMs: number, startFromLine = 0): Promise<string> {
      for (let i = startFromLine; i < allLines.length; i++) {
        if (pattern.test(allLines[i])) return Promise.resolve(allLines[i]);
      }
      // Check the incomplete current line — input prompts sit here waiting for input.
      const trimmedTail = tail.replace(/\r/g, '').trim();
      if (trimmedTail.length > 0 && pattern.test(trimmedTail)) {
        return Promise.resolve(trimmedTail);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.timer === timer);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `Timeout (${timeoutMs}ms) waiting for ${pattern}\nLast lines:\n${allLines.slice(-20).join('\n')}`,
            ),
          );
        }, timeoutMs);
        waiters.push({ pattern, resolve, reject, timer });
      });
    },

    exit(timeoutMs = 15_000): Promise<void> {
      return new Promise((resolve) => {
        let resolved = false;
        const fallback = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            try {
              proc.kill();
            } catch {
              /* ignore */
            }
            resolve();
          }
        }, timeoutMs);
        proc.onExit(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(fallback);
            resolve();
          }
        });
        // Caller is responsible for initiating exit (e.g. writeLine('/exit')).
        // This method only waits and force-kills if the process hasn't exited by timeoutMs.
      });
    },

    lines(): string[] {
      return [...allLines];
    },
  };
}
