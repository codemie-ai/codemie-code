import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';

/**
 * Resolves with the matching line when stdout matches pattern.
 * Rejects on timeout or process exit before match.
 */
export function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = createInterface({ input: proc.stdout! });

    const timer = setTimeout(() => {
      rl.close();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${pattern}.\nGot:\n${lines.join('\n')}`));
    }, timeoutMs);

    rl.on('line', (line) => {
      lines.push(line);
      if (pattern.test(line)) {
        clearTimeout(timer);
        rl.close();
        resolve(line);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      rl.close();
      if (code !== 0) {
        reject(new Error(`Process exited with code ${code} before matching ${pattern}`));
      }
    });
  });
}

/**
 * Send SIGTERM and wait for the process to exit.
 * Falls back to SIGKILL after 5 seconds.
 */
export function cleanKill(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(() => proc.kill('SIGKILL'), 5000);
    proc.on('close', () => { clearTimeout(fallback); resolve(); });
    proc.kill('SIGTERM');
  });
}
