import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';

const promptMock = vi.hoisted(() => vi.fn());

vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

import {
  buildAnalyticsConfirmationMessage,
  promptAnalyticsConfirmation,
  type AnalyticsConfirmationOptions,
} from '../analytics-confirmation.js';

type MessageScope = AnalyticsConfirmationOptions['scope'];
type MessageAllowlist = AnalyticsConfirmationOptions['allowlist'];

const GLOBAL_MESSAGE = 'Global analytics will be enabled for all your Claude Code sessions.';
const PROJECT_MESSAGE = 'Analytics will be enabled for your Claude Code sessions in the project:';
const INVALID_NOTE = 'The project list in Claude Code settings cannot be read and will be replaced.';

const ALLOWLISTS: Array<[string, MessageAllowlist]> = [
  ['a missing allowlist', { kind: 'absent' }],
  ['an empty allowlist', { kind: 'valid', paths: [] }],
  ['an allowlist with projects', { kind: 'valid', paths: ['/repos/project-a', '/repos/project-b'] }],
];

function options(
  scope: MessageScope,
  allowlist: MessageAllowlist,
  extra: Partial<AnalyticsConfirmationOptions> = {},
): AnalyticsConfirmationOptions {
  return {
    scope,
    allowlist,
    currentProjectPath: '/repos/project-c',
    profile: 'work',
    codeMieUrl: 'https://codemie.example.com',
    ...extra,
  };
}

/** The message as plain text, one array entry per line. */
function plainLines(message: string): string[] {
  return stripAnsi(message).split('\n');
}

const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');

function setColumns(columns: number | undefined): void {
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true, writable: true });
}

beforeEach(() => {
  // Wide terminal by default so text is not wrapped; wrapping has its own tests.
  setColumns(10_000);
});

afterEach(() => {
  if (originalColumns) {
    Object.defineProperty(process.stdout, 'columns', originalColumns);
  } else {
    delete (process.stdout as { columns?: number }).columns;
  }
});

describe('buildAnalyticsConfirmationMessage — Global (default)', () => {
  it.each(ALLOWLISTS)('shows the profile, CodeMie URL and one message for %s', (_label, allowlist) => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options('user', allowlist)));

    expect(lines).toEqual([
      'Using profile: work',
      'CodeMie URL: https://codemie.example.com',
      '',
      GLOBAL_MESSAGE,
      '',
    ]);
  });

  it('does not list previously enabled projects or mention the current project', () => {
    const message = stripAnsi(
      buildAnalyticsConfirmationMessage(
        options('user', { kind: 'valid', paths: ['/repos/project-a', '/repos/project-b'] }),
      ),
    );

    expect(message).not.toContain('/repos/project-a');
    expect(message).not.toContain('/repos/project-b');
    expect(message).not.toContain('/repos/project-c');
  });

  it('omits the CodeMie URL line when no URL is configured but keeps the profile', () => {
    const lines = plainLines(
      buildAnalyticsConfirmationMessage(options('user', { kind: 'absent' }, { codeMieUrl: undefined })),
    );

    expect(lines).toEqual(['Using profile: work', '', GLOBAL_MESSAGE, '']);
  });

  it('warns that an unreadable allowlist is replaced, before the message', () => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options('user', { kind: 'invalid' })));

    expect(lines).toEqual([
      'Using profile: work',
      'CodeMie URL: https://codemie.example.com',
      '',
      INVALID_NOTE,
      '',
      GLOBAL_MESSAGE,
      '',
    ]);
  });
});

describe('buildAnalyticsConfirmationMessage — Project (explicit opt-in)', () => {
  it.each(ALLOWLISTS)('names the current project under the message for %s', (_label, allowlist) => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options('project', allowlist)));

    expect(lines).toEqual([
      'Using profile: work',
      'CodeMie URL: https://codemie.example.com',
      '',
      PROJECT_MESSAGE,
      '/repos/project-c',
      '',
    ]);
  });

  it('mentions the project only once and has no summary line for it at the top', () => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options('project', { kind: 'absent' })));

    expect(lines.filter((line) => line.includes('/repos/project-c'))).toHaveLength(1);
    expect(lines.some((line) => /^Projects?:/.test(line))).toBe(false);
  });

  it('keeps a project path with spaces on a single line', () => {
    setColumns(30);
    const projectPath = 'C:\\Users\\Jane Doe\\my projects\\app';

    const lines = plainLines(
      buildAnalyticsConfirmationMessage(options('project', { kind: 'absent' }, { currentProjectPath: projectPath })),
    );

    expect(lines).toContain(projectPath);
  });

  it('warns that an unreadable allowlist is replaced, before the message', () => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options('project', { kind: 'invalid' })));

    expect(lines.slice(3)).toEqual([INVALID_NOTE, '', PROJECT_MESSAGE, '/repos/project-c', '']);
  });
});

describe('buildAnalyticsConfirmationMessage — consistency and removed content', () => {
  const allowlists: MessageAllowlist[] = [...ALLOWLISTS.map(([, allowlist]) => allowlist), { kind: 'invalid' }];

  it('words both messages the same way', () => {
    for (const message of [GLOBAL_MESSAGE, PROJECT_MESSAGE]) {
      expect(message).toContain('nalytics will be enabled for');
      expect(message).toContain('your Claude Code sessions');
      expect(message).not.toMatch(/\b[Ww]e\b/);
    }
  });

  it.each(['user', 'project'] as const)('has no settings status or project lists for %s scope', (scope) => {
    for (const allowlist of allowlists) {
      const message = stripAnsi(buildAnalyticsConfirmationMessage(options(scope, allowlist)));

      expect(message).not.toContain('Already enabled');
      expect(message).not.toContain('About to add');
      expect(message).not.toContain('not yet configured');
      expect(message).not.toContain('settings are configured');
      expect(message).not.toContain('already enabled');
      expect(message).not.toContain('currently collected');
      expect(message).not.toContain('Please confirm');
      expect(message).not.toContain('/repos/project-a');
      expect(message).not.toMatch(/^\s*- /m);
    }
  });
});

describe('buildAnalyticsConfirmationMessage — layout', () => {
  it('starts every line at column 0', () => {
    for (const scope of ['user', 'project'] as const) {
      const lines = plainLines(buildAnalyticsConfirmationMessage(options(scope, { kind: 'invalid' })));

      for (const line of lines.filter((l) => l.length > 0)) {
        expect(line).toMatch(/^\S/);
      }
    }
  });

  it('wraps the message to the terminal width without indenting wrapped lines', () => {
    setColumns(30);

    const lines = plainLines(buildAnalyticsConfirmationMessage(options('user', { kind: 'absent' }))).slice(3);
    const bodyLines = lines.filter((line) => line.length > 0);

    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) {
      expect(line).toMatch(/^\S/);
      expect(line.length).toBeLessThanOrEqual(30);
    }
    expect(bodyLines.join(' ')).toBe(GLOBAL_MESSAGE);
  });

  it('falls back to 80 columns when the terminal width is unknown', () => {
    setColumns(undefined);

    const lines = plainLines(buildAnalyticsConfirmationMessage(options('project', { kind: 'invalid' })));

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });
});

describe('promptAnalyticsConfirmation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    promptMock.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('asks Confirm then Decline with an inquirer list, like codemie setup', async () => {
    promptMock.mockResolvedValue({ enable: true });

    await promptAnalyticsConfirmation(options('user', { kind: 'absent' }));

    expect(promptMock).toHaveBeenCalledTimes(1);
    const [questions] = promptMock.mock.calls[0];
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      type: 'list',
      message: 'Enable Claude Code analytics?',
      choices: [
        { name: 'Confirm', value: true },
        { name: 'Decline', value: false },
      ],
    });
  });

  it('prints the message before the question and does not clear the screen', async () => {
    const order: string[] = [];
    logSpy.mockImplementation(() => {
      order.push('log');
    });
    promptMock.mockImplementation(async () => {
      order.push('prompt');
      return { enable: true };
    });

    await promptAnalyticsConfirmation(options('user', { kind: 'absent' }));

    expect(order).toEqual(['log', 'prompt']);
    expect(stripAnsi(String(logSpy.mock.calls[0][0]))).toContain('Using profile: work');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('resolves enable when Confirm is chosen', async () => {
    promptMock.mockResolvedValue({ enable: true });

    await expect(promptAnalyticsConfirmation(options('user', { kind: 'absent' }))).resolves.toBe('enable');
  });

  it('resolves cancel when Decline is chosen', async () => {
    promptMock.mockResolvedValue({ enable: false });

    await expect(promptAnalyticsConfirmation(options('project', { kind: 'absent' }))).resolves.toBe('cancel');
  });

  it.each(['ExitPromptError', 'AbortPromptError'])('resolves cancel when the prompt is closed (%s)', async (name) => {
    const error = new Error('closed');
    error.name = name;
    promptMock.mockRejectedValue(error);

    await expect(promptAnalyticsConfirmation(options('user', { kind: 'absent' }))).resolves.toBe('cancel');
  });

  it('propagates unexpected prompt errors', async () => {
    promptMock.mockRejectedValue(new Error('boom'));

    await expect(promptAnalyticsConfirmation(options('user', { kind: 'absent' }))).rejects.toThrow('boom');
  });
});
