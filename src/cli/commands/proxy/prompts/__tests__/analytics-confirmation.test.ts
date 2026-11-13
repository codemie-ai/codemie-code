import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';

const promptMock = vi.hoisted(() => vi.fn());

vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

import {
  buildAnalyticsConfirmationMessage,
  promptAnalyticsConfirmation,
  type AnalyticsConfirmationOptions,
} from '../analytics-confirmation.js';

type MessageAllowlist = AnalyticsConfirmationOptions['allowlist'];

const INVALID_NOTE = 'The project list in Claude Code settings cannot be read and will be replaced.';

const ALLOWLISTS: Array<[string, MessageAllowlist]> = [
  ['a missing allowlist', { kind: 'absent' }],
  ['an empty allowlist', { kind: 'valid', paths: [] }],
  ['an allowlist with projects', { kind: 'valid', paths: ['/repos/project-a', '/repos/project-b'] }],
];

function options(
  allowlist: MessageAllowlist,
  extra: Partial<AnalyticsConfirmationOptions> = {},
): AnalyticsConfirmationOptions {
  return {
    allowlist,
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
  it.each(ALLOWLISTS)('shows only the profile and CodeMie URL for %s', (_label, allowlist) => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options(allowlist)));

    expect(lines).toEqual(['Using profile: work', 'CodeMie URL: https://codemie.example.com', '']);
  });

  it('omits the CodeMie URL line when no URL is configured but keeps the profile', () => {
    const lines = plainLines(
      buildAnalyticsConfirmationMessage(options({ kind: 'absent' }, { codeMieUrl: undefined })),
    );

    expect(lines).toEqual(['Using profile: work', '']);
  });

  it('warns that an unreadable allowlist is replaced', () => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options({ kind: 'invalid' })));

    expect(lines).toEqual([
      'Using profile: work',
      'CodeMie URL: https://codemie.example.com',
      '',
      INVALID_NOTE,
      '',
    ]);
  });
});

describe('buildAnalyticsConfirmationMessage — Project (explicit opt-in)', () => {
  it.each(ALLOWLISTS)('adds the analytics project name for %s', (_label, allowlist) => {
    const lines = plainLines(buildAnalyticsConfirmationMessage(options(allowlist, { projectName: 'owner/repo' })));

    expect(lines).toEqual([
      'Using profile: work',
      'CodeMie URL: https://codemie.example.com',
      'Project: owner/repo',
      '',
    ]);
  });

  it('warns that an unreadable allowlist is replaced, after the project line', () => {
    const lines = plainLines(
      buildAnalyticsConfirmationMessage(options({ kind: 'invalid' }, { projectName: 'owner/repo' })),
    );

    expect(lines.slice(2)).toEqual(['Project: owner/repo', '', INVALID_NOTE, '']);
  });
});

describe('buildAnalyticsConfirmationMessage — removed content', () => {
  const allowlists: MessageAllowlist[] = [...ALLOWLISTS.map(([, allowlist]) => allowlist), { kind: 'invalid' }];

  it.each([undefined, 'owner/repo'])('has no enablement message, settings status or project lists (project: %s)', (projectName) => {
    for (const allowlist of allowlists) {
      const message = stripAnsi(buildAnalyticsConfirmationMessage(options(allowlist, { projectName })));

      expect(message).not.toContain('will be enabled');
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
    for (const projectName of [undefined, 'owner/repo']) {
      const lines = plainLines(buildAnalyticsConfirmationMessage(options({ kind: 'invalid' }, { projectName })));

      for (const line of lines.filter((l) => l.length > 0)) {
        expect(line).toMatch(/^\S/);
      }
    }
  });

  it('wraps the note to the terminal width without indenting wrapped lines', () => {
    setColumns(30);

    const lines = plainLines(buildAnalyticsConfirmationMessage(options({ kind: 'invalid' }))).slice(3);
    const bodyLines = lines.filter((line) => line.length > 0);

    expect(bodyLines.length).toBeGreaterThan(1);
    for (const line of bodyLines) {
      expect(line).toMatch(/^\S/);
      expect(line.length).toBeLessThanOrEqual(30);
    }
    expect(bodyLines.join(' ')).toBe(INVALID_NOTE);
  });

  it('falls back to 80 columns when the terminal width is unknown', () => {
    setColumns(undefined);

    const lines = plainLines(buildAnalyticsConfirmationMessage(options({ kind: 'invalid' }, { projectName: 'owner/repo' })));

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

    await promptAnalyticsConfirmation(options({ kind: 'absent' }));

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

    await promptAnalyticsConfirmation(options({ kind: 'absent' }));

    expect(order).toEqual(['log', 'prompt']);
    expect(stripAnsi(String(logSpy.mock.calls[0][0]))).toContain('Using profile: work');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('resolves enable when Confirm is chosen', async () => {
    promptMock.mockResolvedValue({ enable: true });

    await expect(promptAnalyticsConfirmation(options({ kind: 'absent' }))).resolves.toBe('enable');
  });

  it('resolves cancel when Decline is chosen', async () => {
    promptMock.mockResolvedValue({ enable: false });

    await expect(promptAnalyticsConfirmation(options({ kind: 'absent' }))).resolves.toBe('cancel');
  });

  it.each(['ExitPromptError', 'AbortPromptError'])('resolves cancel when the prompt is closed (%s)', async (name) => {
    const error = new Error('closed');
    error.name = name;
    promptMock.mockRejectedValue(error);

    await expect(promptAnalyticsConfirmation(options({ kind: 'absent' }))).resolves.toBe('cancel');
  });

  it('propagates unexpected prompt errors', async () => {
    promptMock.mockRejectedValue(new Error('boom'));

    await expect(promptAnalyticsConfirmation(options({ kind: 'absent' }))).rejects.toThrow('boom');
  });
});
