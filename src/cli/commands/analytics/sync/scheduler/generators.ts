/**
 * Pure generators for the OS scheduler job definitions behind
 * `codemie analytics sync install`.
 *
 * Every export here is a pure string/value builder — no I/O, no process spawning. The thin
 * register/unregister/query wiring that writes these to disk and talks to the OS scheduler
 * lives in `./index.ts`.
 */

import { realpath } from 'fs/promises';

import { SyncConfigError } from '@/utils/errors.js';

/** launchd job label, shared with the standalone collector so install replaces its job. */
export const LAUNCHD_LABEL = 'com.epam.codemie.analytics-sync';
/** systemd user unit base name (service + timer share it), collector-compatible. */
export const SYSTEMD_UNIT_NAME = 'codemie-analytics-sync';
/** Windows Task Scheduler task name, collector-compatible. */
export const WINDOWS_TASK_NAME = 'CodeMie Analytics Sync';

const NAME_MAX_LENGTH = 100;
/** Control characters (incl. C1, line/paragraph separators) and lone surrogates. */
const NAME_FORBIDDEN_CHARS = /[\p{Cc}\p{Cs}\u2028\u2029]/u;

/**
 * Validates a scheduler task name and returns it unchanged. The name is used as-is on every
 * platform (launchd label and plist file name, systemd unit base name, Windows `schtasks /TN`).
 * Callers trim user input first; this function itself rejects names with leading or trailing
 * whitespace. Throws `SyncConfigError` naming the broken rule: empty, surrounding whitespace,
 * control characters, `/` or `\`, `..`, a leading `-` or `.`, or more than 100 characters.
 * Spaces and other printable characters are allowed here; {@link assertNameSupportedOnPlatform}
 * adds the limits an individual OS imposes.
 */
export function validateSchedulerName(name: string): string {
  if (name === '') {
    throw new SyncConfigError('Scheduler task name must not be empty.');
  }
  if (name !== name.trim()) {
    throw new SyncConfigError('Scheduler task name must not start or end with whitespace.');
  }
  if (NAME_FORBIDDEN_CHARS.test(name)) {
    throw new SyncConfigError('Scheduler task name must not contain control characters.');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new SyncConfigError('Scheduler task name must not contain "/" or "\\".');
  }
  if (name.includes('..')) {
    throw new SyncConfigError('Scheduler task name must not contain "..".');
  }
  if (name.startsWith('-') || name.startsWith('.')) {
    throw new SyncConfigError('Scheduler task name must not start with "-" or ".".');
  }
  if ([...name].length > NAME_MAX_LENGTH) {
    throw new SyncConfigError(`Scheduler task name must be at most ${NAME_MAX_LENGTH} characters long.`);
  }
  return name;
}

/** systemd unit names allow only these characters (`@` is excluded: it makes a template instance). */
const SYSTEMD_NAME_ALLOWED = /^[A-Za-z0-9:_.-]+$/;
/** Characters Windows Task Scheduler rejects in a task name. */
const WINDOWS_NAME_FORBIDDEN = /[:*?"<>|]/;

/**
 * Throws `SyncConfigError` when the OS cannot take an otherwise valid `name` as a job name:
 * systemd unit names cannot hold spaces or most punctuation, Task Scheduler rejects
 * `: * ? " < > |`. Runs at install time, before any existing job is touched.
 */
export function assertNameSupportedOnPlatform(name: string, platform: NodeJS.Platform): void {
  if (platform === 'linux' && !SYSTEMD_NAME_ALLOWED.test(name)) {
    throw new SyncConfigError(
      `Scheduler task name "${name}" is not valid for systemd: only letters, digits, ":", "_", "." and "-" are allowed on Linux.`
    );
  }
  if (platform === 'win32' && WINDOWS_NAME_FORBIDDEN.test(name)) {
    throw new SyncConfigError(
      `Scheduler task name "${name}" is not valid for Windows Task Scheduler: it must not contain : * ? " < > |`
    );
  }
}

/** The job command: absolute node binary, absolute CLI entry script, and its argv. */
export interface JobCommand {
  node: string;
  entry: string;
  args: string[];
}

/**
 * Resolve the job command run by the scheduled job: `process.execPath` plus the realpath of
 * the running CLI entry script (`process.argv[1]`), so a shim/symlink entry (e.g. an npm bin
 * wrapper) resolves to the real script — no `.cmd` shim on Windows.
 */
export async function resolveJobCommand(): Promise<JobCommand> {
  const entry = await realpath(process.argv[1] ?? '');
  return {
    node: process.execPath,
    entry,
    args: ['analytics', 'sync', 'run', '--scheduled']
  };
}

interface ParsedAt {
  hour: number;
  minute: number;
}

function parseAt(at: string): ParsedAt {
  const [hourText, minuteText] = at.split(':');
  return { hour: Number(hourText), minute: Number(minuteText) };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plistString(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

function programArguments(cmd: JobCommand): string[] {
  return [cmd.node, cmd.entry, ...cmd.args];
}

/** Quote one systemd `ExecStart=` argument. Inside double quotes systemd still expands `%`
 * specifiers, `$` variables and C-style backslash escapes, so each is escaped literally. */
function systemdQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, () => '$$');
  return `"${escaped}"`;
}

/** Quote one Windows command-line argument (MSVCRT rules node uses to split `<Arguments>`):
 * wrap in quotes when it holds whitespace or a quote (or `always`), double the backslashes
 * that precede a quote or the closing quote, and escape embedded quotes. */
function windowsQuote(value: string, always = false): string {
  if (!always && value !== '' && !/[\s"]/.test(value)) {
    return value;
  }
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * macOS launchd plist: `StartCalendarInterval` from `at` (`HH:MM`), `RunAtLoad=false` (the
 * job only ever runs on its daily schedule, never at login/registration), stdout/stderr
 * pointed at `logPath` — a launchd-only log, never the run log: `run` already appends its
 * own outcome line there, so sharing it would write every line twice.
 */
export function launchdPlist(cmd: JobCommand, at: string, logPath: string, label: string): string {
  const { hour, minute } = parseAt(at);
  const args = programArguments(cmd)
    .map((value) => `        ${plistString(value)}`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    ${plistString(label)}
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    ${plistString(logPath)}
    <key>StandardErrorPath</key>
    ${plistString(logPath)}
</dict>
</plist>
`;
}

/**
 * Linux systemd user service + timer. `Type=oneshot` (the job exits once it has sent/failed,
 * it is not long-running); `OnCalendar=*-*-* HH:MM:00` from `at`; `Persistent=true` (a missed
 * run — machine asleep/off — fires once at next boot); `RandomizedDelaySec=300` (spreads load
 * across machines that share the same `at`).
 */
export function systemdUnits(cmd: JobCommand, at: string): { service: string; timer: string } {
  const execStart = programArguments(cmd).map((value) => systemdQuote(value)).join(' ');

  const service = `[Unit]
Description=CodeMie analytics sync (daily)

[Service]
Type=oneshot
ExecStart=${execStart}
`;

  const timer = `[Unit]
Description=CodeMie analytics sync daily timer

[Timer]
OnCalendar=*-*-* ${at}:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * Windows Task Scheduler XML for `schtasks /Create /XML`. `StartWhenAvailable` (fires once
 * the machine is next available if it missed `at`); `IgnoreNew` (no overlapping runs);
 * `InteractiveToken`/`LeastPrivilege` (runs as the logged-in user, no elevation); runs on
 * battery too (`DisallowStartIfOnBatteries`/`StopIfGoingOnBatteries` false — the defaults
 * would skip or kill it on an unplugged laptop); `ExecutionTimeLimit=PT30M` caps a stuck run.
 * `<Command>` is the node binary path (no `.cmd` shim); `<Arguments>` carries the quoted entry
 * script (a profile path may hold spaces) and the CLI args.
 *
 * The returned string is plain UTF-16 XML text; encoding it as UTF-16LE with a BOM into the
 * temp file `schtasks` reads is the caller's job (`./index.ts`), not this generator's.
 */
export function taskSchedulerXml(cmd: JobCommand, at: string): string {
  const { hour, minute } = parseAt(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const startBoundary = `${new Date().toISOString().slice(0, 10)}T${pad(hour)}:${pad(minute)}:00`;
  const args = [windowsQuote(cmd.entry, true), ...cmd.args.map((arg) => windowsQuote(arg))]
    .map(xmlEscape)
    .join(' ');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CodeMie analytics sync (daily)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmd.node)}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
