import { createInterface } from 'node:readline';
import type { ChildProcess } from 'node:child_process';

/**
 * Resolves with the matching line when stdout (and optionally stderr) matches pattern.
 * Rejects on timeout or process exit before match.
 */
export function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
  { includeStderr = false }: { includeStderr?: boolean } = {}
): Promise<string> {
  if (!proc.stdout) throw new Error('waitForOutput: process stdout is not piped');
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const interfaces: ReturnType<typeof createInterface>[] = [];

    const handleLine = (line: string): void => {
      lines.push(line);
      if (pattern.test(line)) {
        clearTimeout(timer);
        interfaces.forEach(rl => { try { rl.close(); } catch { /* ignore */ } });
        resolve(line);
      }
    };

    const stdoutRl = createInterface({ input: proc.stdout! });
    stdoutRl.on('line', handleLine);
    interfaces.push(stdoutRl);

    if (includeStderr && proc.stderr) {
      const stderrRl = createInterface({ input: proc.stderr });
      stderrRl.on('line', handleLine);
      interfaces.push(stderrRl);
    }

    const closeAll = (): void => interfaces.forEach(rl => { try { rl.close(); } catch { /* ignore */ } });

    const timer = setTimeout(() => {
      closeAll();
      reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${pattern}.\nGot:\n${lines.join('\n')}`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      closeAll();
      reject(new Error(`Process exited (code ${code ?? 'null'}) before matching ${pattern}.\nGot:\n${lines.join('\n')}`));
    });
  });
}

/**
 * Send SIGTERM and wait for the process to exit.
 * Falls back to SIGKILL after 5 seconds.
 */
export function cleanKill(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } }, 5000);
    proc.on('close', () => { clearTimeout(fallback); resolve(); });
    try { proc.kill('SIGTERM'); } catch { /* process already exited */ }
  });
}
