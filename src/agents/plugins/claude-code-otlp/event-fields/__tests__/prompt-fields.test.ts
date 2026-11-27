import { describe, it, expect } from 'vitest';
import {
  autoPromptSource,
  resolvePromptSource,
  stripInjectedContext,
} from '@/agents/plugins/claude-code-otlp/event-fields/prompt-fields.js';

const OPENED_FILE =
  '<ide_opened_file>The user opened the file /repo/src/EPMCDME-1.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>';
const SELECTION = '<ide_selection>The user selected the lines 1 to 3 from /repo/a.ts:\nconst a = 1;\n</ide_selection>';

describe('stripInjectedContext', () => {
  it.each([
    ['IDE open-file block before the typed text', `${OPENED_FILE}\nfix the build`, 'fix the build'],
    ['IDE selection block with a multi-line body', `${SELECTION}explain this`, 'explain this'],
    ['open-file and selection blocks together', `${OPENED_FILE}${SELECTION}\n\nrefactor it`, 'refactor it'],
    ['system reminder in the middle, text on both sides kept', 'fix <system-reminder>x</system-reminder>this', 'fix this'],
    ['system reminder with attributes', '<system-reminder kind="hook">\nctx\n</system-reminder>\ngo', 'go'],
    ['two blocks of one kind with text between them', `${OPENED_FILE}one${OPENED_FILE}two`, 'onetwo'],
    ['prompt that is only IDE context', OPENED_FILE, ''],
  ])('%s', (_label, input, expected) => {
    expect(stripInjectedContext(input)).toBe(expected);
  });

  it.each([
    ['plain prompt', '  plain prompt  '],
    ['unterminated block', '<ide_opened_file>The user opened\nfix it'],
    ['mismatched closing tag', '<ide_selection>a</ide_opened_file> b'],
    ['tag name only mentioned in prose', 'why does ide_opened_file show up?'],
    ['similar but unknown tag', '<ide_opened_files>x</ide_opened_files> y'],
    ['pasted content is not injected context', '<pasted_content id="a">x</pasted_content id="a">'],
  ])('returns %s unchanged', (_label, input) => {
    expect(stripInjectedContext(input)).toBe(input);
  });
});

describe('autoPromptSource / resolvePromptSource', () => {
  it.each([
    ['<task-notification>\n<task-id>a1</task-id>\n</task-notification>', 'task_notification'],
    ['\n  <task-notification>\n<summary>done</summary>', 'task_notification'],
    ['<agent-message from="reviewer">done</agent-message>', 'agent_message'],
  ] as const)('classifies %j as %s', (prompt, source) => {
    expect(autoPromptSource(prompt)).toBe(source);
    expect(resolvePromptSource(prompt)).toBe(source);
  });

  it.each([
    'plain prompt',
    '',
    'see the <task-notification> above',
    `${OPENED_FILE}<task-notification>`,
  ])('treats %j as a user prompt', (prompt) => {
    expect(autoPromptSource(prompt)).toBeUndefined();
    expect(resolvePromptSource(prompt)).toBe('user');
  });
});
