import { describe, it, expect, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { exec, VERSION_PROBE_OPTIONS } from '../exec.js';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/**
 * Make every child behave as if it ignores SIGTERM: the signal is recorded and swallowed, any other
 * signal goes through. Platform-independent (a Windows process cannot ignore SIGTERM) and independent
 * of child startup time, since the pid comes from the spawned ChildProcess instead of a file the child
 * writes once it has booted.
 */
function ignoreSigterm(): {
  calls: { sig: string; at: number }[];
  child: () => ChildProcess | undefined;
  restore: () => void;
} {
  const realKill = ChildProcess.prototype.kill;
  const calls: { sig: string; at: number }[] = [];
  const targets: ChildProcess[] = [];
  const spy = vi.spyOn(ChildProcess.prototype, 'kill').mockImplementation(function (
    this: ChildProcess,
    sig?: NodeJS.Signals | number
  ) {
    targets.push(this);
    calls.push({ sig: String(sig), at: Date.now() });
    return sig === 'SIGTERM' ? true : realKill.call(this, sig);
  });
  return {
    calls,
    child: () => targets[0],
    restore: () => {
      spy.mockRestore();
      const pid = targets[0]?.pid;
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    },
  };
}

const node = process.execPath;

describe('exec timeout hardening', () => {
  it('rejects once with the existing message on timeout', async () => {
    await expect(exec(node, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200 }))
      .rejects.toThrow('Command timed out after 200ms');
  });

  it('behaves as before without the new options', async () => {
    const r = await exec(node, ['-e', 'console.log("hi")']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
  });

  it('closeStdin gives a stdin-reading child EOF', async () => {
    const r = await exec(
      node,
      ['-e', 'process.stdin.on("data",()=>{});process.stdin.on("end",()=>{console.log("eof")})'],
      { closeStdin: true, timeout: 10000 }
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('eof');
  });

  it('a child that exits on SIGTERM returns well before killGraceMs', async () => {
    const start = Date.now();
    await expect(exec(node, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200, killGraceMs: 3000 }))
      .rejects.toThrow('timed out');
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('SIGKILLs a SIGTERM-ignoring child after the grace period', async () => {
    const { calls, child, restore } = ignoreSigterm();
    try {
      await expect(exec(node, ['-e', 'setInterval(()=>{},1000)'], { timeout: 1000, killGraceMs: 300, closeStdin: true }))
        .rejects.toThrow('timed out');
      expect(await waitFor(() => calls.some((c) => c.sig === 'SIGKILL'), 3000)).toBe(true);
      const term = calls[0];
      const kill = calls.find((c) => c.sig === 'SIGKILL')!;
      expect(term.sig).toBe('SIGTERM');
      expect(kill.at - term.at).toBeGreaterThanOrEqual(250);
      expect(await waitFor(() => !isAlive(child()!.pid!), 3000)).toBe(true);
    } finally {
      restore();
    }
  });

  it('a child holding stdout open does not keep the call pending past timeout', async () => {
    const { child, restore } = ignoreSigterm();
    const start = Date.now();
    try {
      await expect(exec(
        node,
        ['-e', 'setInterval(()=>process.stdout.write("x"),100)'],
        { timeout: 1000, killGraceMs: 300, closeStdin: true }
      )).rejects.toThrow('timed out');
      expect(Date.now() - start).toBeLessThan(2500);
      expect(child()!.stdout!.destroyed).toBe(true);
      expect(child()!.stderr!.destroyed).toBe(true);
      // The child dies once its pipe is gone (broken pipe) or on the grace-period SIGKILL, whichever is first.
      expect(await waitFor(() => !isAlive(child()!.pid!), 3000)).toBe(true);
    } finally {
      restore();
    }
  });

  it('closeStdin alone keeps plain kill on timeout; killGraceMs enables pipe release', async () => {
    const unref = vi.spyOn(ChildProcess.prototype, 'unref');
    try {
      await expect(exec(node, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200, closeStdin: true }))
        .rejects.toThrow('timed out');
      expect(unref).not.toHaveBeenCalled();
      await expect(exec(node, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200, closeStdin: true, killGraceMs: 300 }))
        .rejects.toThrow('timed out');
      expect(unref).toHaveBeenCalled();
    } finally {
      unref.mockRestore();
    }
  });

  it('does not re-settle on a late close after the timeout', async () => {
    const results: string[] = [];
    const p = exec(node, ['-e', 'setTimeout(()=>{},800)'], { timeout: 100 })
      .then(() => results.push('resolved'), () => results.push('rejected'));
    await p;
    await new Promise((r) => setTimeout(r, 1000));
    expect(results).toEqual(['rejected']);
  });

  it('exposes the version probe options', () => {
    expect(VERSION_PROBE_OPTIONS).toEqual({ timeout: 5000, closeStdin: true, killGraceMs: 500 });
  });
});


describe('exec unsetEnv', () => {
  it('removes the listed keys from the inherited environment', async () => {
    process.env.CODEMIE_EXEC_TEST_STRIP = 'inherited';
    try {
      const result = await exec(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.CODEMIE_EXEC_TEST_STRIP))'],
        { unsetEnv: ['CODEMIE_EXEC_TEST_STRIP'] }
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('undefined');
    } finally {
      delete process.env.CODEMIE_EXEC_TEST_STRIP;
    }
  });

  it('keeps inherited keys that are not listed', async () => {
    process.env.CODEMIE_EXEC_TEST_KEEP = 'kept';
    try {
      const result = await exec(
        process.execPath,
        ['-e', 'process.stdout.write(String(process.env.CODEMIE_EXEC_TEST_KEEP))'],
        { unsetEnv: ['CODEMIE_EXEC_TEST_OTHER'] }
      );
      expect(result.stdout).toBe('kept');
    } finally {
      delete process.env.CODEMIE_EXEC_TEST_KEEP;
    }
  });
});
