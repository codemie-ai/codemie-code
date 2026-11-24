import { mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isScheduledSyncRun } from '@/utils/scheduled-run.js';

import { launchdPlist, resolveJobCommand, systemdUnits, taskSchedulerXml, type JobCommand } from '../generators.js';

const CMD: JobCommand = {
  node: '/usr/local/bin/node',
  entry: '/Users/dev & "quote"/codemie/bin/codemie.js',
  args: ['analytics', 'sync', 'run', '--scheduled']
};

describe('launchdPlist', () => {
  const plist = launchdPlist(CMD, '07:05', '/Users/dev/.codemie/logs/analytics-sync.log');

  it('contains the launchd label', () => {
    expect(plist).toContain('<string>com.epam.codemie.analytics-sync</string>');
  });

  it('parses "07:05" into integer Hour/Minute for StartCalendarInterval', () => {
    expect(plist).toContain('<key>Hour</key>\n        <integer>7</integer>');
    expect(plist).toContain('<key>Minute</key>\n        <integer>5</integer>');
  });

  it('sets RunAtLoad to false', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n    <false/>');
  });

  it('XML-escapes paths containing special characters', () => {
    expect(plist).toContain('&amp;');
    expect(plist).toContain('&quot;quote&quot;');
    expect(plist).not.toContain('& "quote"');
  });
});

describe('systemdUnits', () => {
  const { service, timer } = systemdUnits(CMD, '07:05');

  it('service runs as a oneshot executing the job command', () => {
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(CMD.node);
    expect(service).toContain(CMD.entry.replace(/"/g, '\\"'));
  });

  it('timer has OnCalendar=*-*-* 07:05:00 and Persistent=true', () => {
    expect(timer).toContain('OnCalendar=*-*-* 07:05:00');
    expect(timer).toContain('Persistent=true');
  });

  it('timer sets a RandomizedDelaySec', () => {
    expect(timer).toContain('RandomizedDelaySec=300');
  });

  it('escapes backslashes, %, $ and quotes so systemd passes the paths through unchanged', () => {
    const special = systemdUnits(
      { node: '/opt/n%de/bin/node', entry: '/home/a$b/c\\d/"e"/codemie.js', args: ['run'] },
      '07:05'
    ).service;
    expect(special).toContain('ExecStart="/opt/n%%de/bin/node" "/home/a$$b/c\\\\d/\\"e\\"/codemie.js" "run"');
  });
});

describe('taskSchedulerXml', () => {
  const xml = taskSchedulerXml(CMD, '07:05');

  it('sets StartWhenAvailable to true', () => {
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });

  it('uses the node binary path as <Command>, with no .cmd shim', () => {
    expect(xml).toContain(`<Command>${CMD.node}</Command>`);
    expect(xml).not.toContain('.cmd');
  });

  it('sets IgnoreNew and LeastPrivilege', () => {
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });

  it('caps execution time at PT30M', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>');
  });

  it('runs on battery power and is not stopped when the laptop unplugs', () => {
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  });

  it('quotes an entry path containing spaces so node receives it as one argument', () => {
    const winXml = taskSchedulerXml(
      {
        node: 'C:\\Program Files\\nodejs\\node.exe',
        entry: 'C:\\Users\\First Last\\AppData\\Roaming\\npm\\codemie.js',
        args: ['analytics', 'sync', 'run', '--scheduled']
      },
      '07:05'
    );
    expect(winXml).toContain(
      '<Arguments>&quot;C:\\Users\\First Last\\AppData\\Roaming\\npm\\codemie.js&quot; analytics sync run --scheduled</Arguments>'
    );
  });
});

describe('resolveJobCommand', () => {
  const originalArgv1 = process.argv[1];
  let dir: string | undefined;

  afterEach(async () => {
    process.argv[1] = originalArgv1;
    if (dir) {
      await rm(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('resolves a symlinked entry to its realpath and builds argv the startup gate recognizes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'codemie-job-cmd-'));
    const target = join(dir, 'codemie.js');
    const link = join(dir, 'codemie-shim');
    await writeFile(target, '');
    await symlink(target, link);
    process.argv[1] = link;

    const cmd = await resolveJobCommand();

    expect(cmd.node).toBe(process.execPath);
    expect(cmd.entry).toBe(await realpath(target));
    expect(isScheduledSyncRun([cmd.node, cmd.entry, ...cmd.args])).toBe(true);
  });
});
