import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandRunner } from '@/agents/core/claude-settings.js';
import { BackupAccessError, parseWhoamiSid, restrictToCurrentWindowsUser } from '../backup-access.js';

const SID = 'S-1-5-21-1004336348-1177238915-682003330-512';
const DIR = String.raw`C:\Users\alice\.codemie\backups\bedrock-switch-2026-11-18T10-00-00-000Z`;

describe('restrictToCurrentWindowsUser', () => {
  beforeEach(() => {
    vi.stubEnv('SystemRoot', String.raw`C:\Windows`);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const runner = (results: Record<string, CommandResult>): { run: CommandRunner; calls: Array<[string, string[]]> } => {
    const calls: Array<[string, string[]]> = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, args]);
      const name = command.split('\\').pop() as string;
      return results[name] ?? { code: 0, stdout: '', stderr: '' };
    };
    return { run, calls };
  };

  it('grants full control to the current account by SID and drops the inherited rules', async () => {
    const { run, calls } = runner({ 'whoami.exe': { code: 0, stdout: `"desktop-1\\alice","${SID}"`, stderr: '' } });
    await restrictToCurrentWindowsUser(DIR, run);
    expect(calls).toEqual([
      [String.raw`C:\Windows\System32\whoami.exe`, ['/user', '/fo', 'csv', '/nh']],
      [String.raw`C:\Windows\System32\icacls.exe`, [DIR, '/inheritance:r', '/grant:r', `*${SID}:(OI)(CI)F`]],
    ]);
  });

  it.each([
    ['whoami fails', { 'whoami.exe': { code: 1, stdout: '', stderr: 'denied' } }],
    ['whoami prints no SID', { 'whoami.exe': { code: 0, stdout: '"desktop-1\\alice"', stderr: '' } }],
    [
      'icacls fails',
      {
        'whoami.exe': { code: 0, stdout: `"desktop-1\\alice","${SID}"`, stderr: '' },
        'icacls.exe': { code: 5, stdout: '', stderr: 'Access is denied.' },
      },
    ],
  ])('throws BackupAccessError when %s', async (_label, results) => {
    const { run } = runner(results);
    await expect(restrictToCurrentWindowsUser(DIR, run)).rejects.toBeInstanceOf(BackupAccessError);
  });

  it('never runs icacls without a SID', async () => {
    const { run, calls } = runner({ 'whoami.exe': { code: 1, stdout: '', stderr: '' } });
    await restrictToCurrentWindowsUser(DIR, run).catch(() => undefined);
    expect(calls.map(([command]) => command.split('\\').pop())).toEqual(['whoami.exe']);
  });
});

describe('parseWhoamiSid', () => {
  it('reads the SID from localised or domain output', () => {
    expect(parseWhoamiSid(`"contoso\\Ålice Müller","${SID}"`)).toBe(SID);
    expect(parseWhoamiSid('"azuread\\bob","S-1-12-1-111-222-333-444"')).toBe('S-1-12-1-111-222-333-444');
    expect(parseWhoamiSid('ERROR: no account')).toBeUndefined();
  });
});
