import { describe, it, expect, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function readPid(file: string): Promise<number> {
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, 3000);
  return Number(readFileSync(file, 'utf8'));
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
    const dir = mkdtempSync(join(tmpdir(), 'exec-kill-'));
    const pidFile = join(dir, 'pid');
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},1000)`;
    let pid = 0;
    try {
      await expect(exec(node, ['-e', script], { timeout: 1000, killGraceMs: 300, closeStdin: true }))
        .rejects.toThrow('timed out');
      pid = await readPid(pidFile);
      expect(pid).toBeGreaterThan(0);
      expect(await waitFor(() => !isAlive(pid), 3000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a child holding stdout open does not keep the call pending past timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exec-stdout-'));
    const pidFile = join(dir, 'pid');
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>process.stdout.write("x"),100)`;
    let pid = 0;
    const start = Date.now();
    try {
      await expect(exec(node, ['-e', script], { timeout: 1000, killGraceMs: 300, closeStdin: true }))
        .rejects.toThrow('timed out');
      expect(Date.now() - start).toBeLessThan(2500);
      pid = await readPid(pidFile);
      expect(await waitFor(() => !isAlive(pid), 3000)).toBe(true);
    } finally {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
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
