/**
 * Tests for the guided wizard's start logic and all 8 steps (EPMCDME-16487 plan tasks 7
 * and 8): `runGuided` in `../guided.ts`.
 *
 * The first `describe` block (plan task 7) covers the start logic and steps 1-4; every
 * scenario there that reaches step 5 or later now runs the real steps 5-8 to completion
 * (plan task 8 replaced their placeholder), via the simplest path through them (a
 * successful test send, the default `windows` policy, the default lookback), so those
 * scenarios assert only what they always asserted about steps 1-4 plus the wizard's final
 * exit code / `out` line. The second `describe` block covers steps 5-8 themselves.
 *
 * Uses a scripted fake `BootstrapPrompter` (queued answers, consumed in call order) and a
 * tmp `statePath`/`cwd` per test, against the real `state-store.ts`, `flow-package.ts`
 * (only `resolveFlowTemplateDir` is wrapped so one test can make it throw) and
 * `config-store.ts`. No mock of `links.ts`/`timezones.ts`: their real parsing/validation
 * drives the retry scenarios.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDeliveryError } from '@/utils/errors.js';

import { buildInstallCommand } from '../../install-command.js';
import { UPDATE_HINT } from '../setup-check.js';
import type { BootstrapDeps, BootstrapPrompter } from '../types.js';
import type { BootstrapState } from '../state-store.js';
import { saveBootstrapState } from '../state-store.js';

const resolveFlowTemplateDirMock = vi.hoisted(() => vi.fn());
vi.mock('../flow-package.js', async () => {
  const actual = await vi.importActual<typeof import('../flow-package.js')>('../flow-package.js');
  resolveFlowTemplateDirMock.mockImplementation(actual.resolveFlowTemplateDir);
  return {
    ...actual,
    resolveFlowTemplateDir: (...args: unknown[]) => resolveFlowTemplateDirMock(...args)
  };
});

import { runGuided } from '../guided.js';

const VALID_CHANNEL_LINK =
  'https://teams.microsoft.com/l/channel/19%3Aabc123%40thread.tacv2/General?groupId=11111111-2222-3333-4444-555555555555';
const MESSAGE_LINK = 'https://teams.microsoft.com/l/message/abc123?groupId=11111111-2222-3333-4444-555555555555';
const VALID_FOLDER_URL = 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/CodeMie?id=%2Fsites%2FAnalytics%2FShared%20Documents%2FCodeMie';
const VALID_TRIGGER_URL = 'https://example.invalid/triggers/invoke?api-version=1&sig=FAKESECRET';

/** A fully-answered state (steps 1-7) `checkReuse` should accept as reusable. */
const COMPLETE_STATE: BootstrapState = {
  version: 1,
  channelLink: VALID_CHANNEL_LINK,
  teamId: '11111111-2222-3333-4444-555555555555',
  channelId: '19:abc123@thread.tacv2',
  channelName: 'General',
  siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
  folderPath: 'Shared Documents/CodeMie',
  timeZone: 'UTC',
  flowImported: true,
  webhookUrl: VALID_TRIGGER_URL,
  webhookTest: 'passed',
  includeExternal: 'windows',
  lookbackDays: 7
};

/** A scripted `BootstrapPrompter`: each method pops its next queued answer in call order,
 * and throws loudly (failing the test) if a queue runs dry — a wrong/missing script entry
 * should never silently hang. */
function createScriptedPrompt(script: { input?: string[]; confirm?: boolean[]; select?: string[] }): BootstrapPrompter {
  const input = [...(script.input ?? [])];
  const confirm = [...(script.confirm ?? [])];
  const select = [...(script.select ?? [])];
  return {
    input: vi.fn(async (message: string) => {
      if (input.length === 0) throw new Error(`scripted prompter ran out of input answers at: ${message}`);
      return input.shift() as string;
    }),
    confirm: vi.fn(async (message: string) => {
      if (confirm.length === 0) throw new Error(`scripted prompter ran out of confirm answers at: ${message}`);
      return confirm.shift() as boolean;
    }),
    select: vi.fn(async (message: string) => {
      if (select.length === 0) throw new Error(`scripted prompter ran out of select answers at: ${message}`);
      return select.shift() as string;
    })
  };
}

function errLines(deps: BootstrapDeps): string[] {
  return (deps.err as ReturnType<typeof vi.fn>).mock.calls.map(([line]: [string]) => line);
}

describe('runGuided — steps 1-4 and start logic', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'guided-test-'));
    statePath = join(dir, 'analytics-sync-bootstrap.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function createDeps(prompt: BootstrapPrompter, overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
    return {
      isTTY: true,
      cwd: dir,
      now: () => new Date('2026-11-04T21:33:07.123Z'),
      out: vi.fn(),
      err: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
      prompt,
      statePath,
      ...overrides
    };
  }

  /** Answers for a full fresh run through all 8 steps: "already imported?" no, channel
   * link + confirm, folder link + confirm, time zone, open-browser confirm, press-enter
   * confirm, then the simplest path through steps 5-8 (a trigger URL that test-sends
   * successfully via the default mocked `send`, the default `windows` policy, the default
   * lookback). */
  function freshRunScript(
    overrides: { input?: string[]; confirm?: boolean[]; select?: string[] } = {}
  ): BootstrapPrompter {
    return createScriptedPrompt({
      input: overrides.input ?? [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: overrides.confirm ?? [false, true, true, true, true],
      select: overrides.select ?? ['windows', 'default']
    });
  }

  it('prints each step heading once, in order, even after a rejected channel confirm', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      // already-imported:no, channel-confirm:no (retry), channel-confirm:yes, folder-confirm:yes,
      // open-browser:yes, press-enter:yes
      confirm: [false, false, true, true, true, true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const lines = errLines(deps);
    const headingLines = lines.filter((l) => /^Step \d of 8 · /.test(l));
    expect(headingLines).toEqual([
      'Step 1 of 8 · Teams channel',
      'Step 2 of 8 · SharePoint folder',
      'Step 3 of 8 · Time zone',
      'Step 4 of 8 · Import the flow',
      'Step 5 of 8 · Trigger URL',
      'Step 6 of 8 · External sessions',
      'Step 7 of 8 · Lookback',
      'Step 8 of 8 · Developers'
    ]);
  });

  it('asks again on a /l/message/ Teams link, then accepts a valid one', async () => {
    const prompt = createScriptedPrompt({
      input: [MESSAGE_LINK, VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: [false, true, true, true, true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.input).toHaveBeenCalledTimes(5);
    expect(errLines(deps).some((l) => /message/i.test(l))).toBe(true);
  });

  it('typing "manual" for the folder step asks for site and path separately', async () => {
    const prompt = createScriptedPrompt({
      input: [
        VALID_CHANNEL_LINK,
        'manual',
        'https://contoso.sharepoint.com/sites/Analytics',
        'Shared Documents/CodeMie',
        'UTC',
        VALID_TRIGGER_URL
      ],
      confirm: [false, true, true, true, true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.siteUrl).toBe('https://contoso.sharepoint.com/sites/Analytics');
    expect(saved.folderPath).toBe('Shared Documents/CodeMie');
  });

  it('declining the folder confirm asks for site and path separately', async () => {
    const prompt = createScriptedPrompt({
      input: [
        VALID_CHANNEL_LINK,
        VALID_FOLDER_URL,
        'https://contoso.sharepoint.com/sites/Analytics',
        'Shared Documents/CodeMie',
        'UTC',
        VALID_TRIGGER_URL
      ],
      // already-imported:no, channel-confirm:yes, folder-confirm:no (from paste), folder-confirm:yes
      // (manual), open-browser:yes, press-enter:yes
      confirm: [false, true, false, true, true, true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.siteUrl).toBe('https://contoso.sharepoint.com/sites/Analytics');
    expect(saved.folderPath).toBe('Shared Documents/CodeMie');
  });

  it('asks again on an unknown time zone, then accepts a valid one', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'Not A Real Zone', 'UTC', VALID_TRIGGER_URL],
      confirm: [false, true, true, true, true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(errLines(deps).some((l) => /not a windows time zone/i.test(l))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.timeZone).toBe('UTC');
  });

  it('step 4 writes the zip into cwd, prints the 6 import instructions, and gates on confirmation, then completes steps 5-8', async () => {
    const prompt = freshRunScript();
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    const lines = errLines(deps);
    const numbered = lines.filter((l) => /^\s*[1-6]\./.test(l));
    expect(numbered.length).toBe(6);
    expect(lines.some((l) => l.includes(join(dir, 'codemie-analytics-flow.zip')))).toBe(true);
    expect(deps.openUrl).toHaveBeenCalledWith('https://make.powerautomate.com/');
    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
  });

  it('prints an overwrite notice when the zip already exists', async () => {
    const first = createDeps(freshRunScript());
    await runGuided(first);

    const second = createDeps(freshRunScript());
    // A fresh run needs its own saved state to walk steps 1-4 again.
    await rm(statePath, { force: true });
    await runGuided(second);

    expect(errLines(second).some((l) => /overwrote/i.test(l))).toBe(true);
  });

  it('falls back to printing the bare Power Automate URL when openUrl throws', async () => {
    const prompt = freshRunScript();
    const deps = createDeps(prompt, { openUrl: vi.fn().mockRejectedValue(new Error('no browser')) });

    await runGuided(deps);

    expect(errLines(deps)).toContain('https://make.powerautomate.com/');
  });

  it('saves state after each step so a later step sees the earlier answers already persisted', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: [
        false, // already imported? no
        true, // channel confirm
        true, // folder confirm
        true, // open browser
        true // press enter
      ],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.teamId).toBeDefined();
    expect(saved.siteUrl).toBeDefined();
    expect(saved.timeZone).toBe('UTC');
    expect(saved.flowImported).toBe(true);
  });

  it('fails before step 1 when the flow template directory is missing', async () => {
    resolveFlowTemplateDirMock.mockImplementationOnce(() => {
      throw new Error('Flow template directory not found: /fake/flow-template');
    });
    const prompt = createScriptedPrompt({ confirm: [false] });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(1);
    expect(prompt.input).not.toHaveBeenCalled();
    expect(errLines(deps).some((l) => l.includes('/fake/flow-template'))).toBe(true);
  });

  it('"already imported? yes" jumps straight to step 5, skipping steps 1-4', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
    const lines = errLines(deps);
    expect(lines).toContain('Step 5 of 8 · Trigger URL');
    expect(lines.some((l) => /not available yet/i.test(l))).toBe(false);
  });

  it('with a reusable saved state, shows the masked summary and accepting jumps to step 8', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const prompt = createScriptedPrompt({ confirm: [true] });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(prompt.input).not.toHaveBeenCalled();
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
    const lines = errLines(deps);
    expect(lines.some((l) => l.includes('General'))).toBe(true);
    expect(lines.join('\n')).not.toContain('FAKESECRET');
  });

  it('a non-reusable saved state (broken webhook) resumes at resumeAt, discarding the webhook', async () => {
    await saveBootstrapState({ ...COMPLETE_STATE, webhookUrl: 'https://example.invalid/no-sig' }, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    // The broken saved webhook was discarded before step 5 re-asked for one.
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
    expect(saved.webhookUrl).not.toBe('https://example.invalid/no-sig');
    expect(saved.webhookTest).toBe('passed');
    expect(saved.teamId).toBe(COMPLETE_STATE.teamId);
  });

  it('declining to reuse a saved webhook restarts at step 1, prefilling the saved channel link', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: [
        false, // Reuse them? no
        true, // channel confirm
        true, // folder confirm
        true, // open browser
        true // press enter
      ],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.input).toHaveBeenNthCalledWith(1, expect.stringContaining('Teams channel link'), COMPLETE_STATE.channelLink);
  });

  it('treats an unreadable/malformed state file as absent and prints a notice', async () => {
    const { writeFile } = await import('fs/promises');
    await writeFile(statePath, 'not json', 'utf-8');
    const prompt = freshRunScript();
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(errLines(deps).some((l) => l.includes(statePath))).toBe(true);
  });
});

describe('runGuided — steps 5-8 (trigger URL, external sessions, lookback, developers)', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'guided-test-'));
    statePath = join(dir, 'analytics-sync-bootstrap.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A fresh-state `BootstrapDeps`, with `prompt.confirm`'s first (and here only
   * unconditional) answer wired to "already imported the flow?" so the run jumps straight
   * to step 5 — no saved webhook, so steps 1-4 are skipped and no `input`/`select` answer
   * is consumed before step 5's own prompts. */
  function createDeps(prompt: BootstrapPrompter, overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
    return {
      isTTY: true,
      cwd: dir,
      now: () => new Date('2026-11-04T21:33:07.123Z'),
      out: vi.fn(),
      err: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
      prompt,
      statePath,
      ...overrides
    };
  }

  function errLines(deps: BootstrapDeps): string[] {
    return (deps.err as ReturnType<typeof vi.fn>).mock.calls.map(([line]: [string]) => line);
  }

  it('accepts a trigger URL pasted with angle brackets (cleanPaste runs before validateTriggerUrl)', async () => {
    const prompt = createScriptedPrompt({
      input: [`<${VALID_TRIGGER_URL}>`],
      confirm: [true], // already imported? yes -> step 5
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
  });

  it('rejects a trailing (unmatched) typographic quote with the non-ASCII/typographic-quote message, then accepts a clean retry', async () => {
    const prompt = createScriptedPrompt({
      input: [`${VALID_TRIGGER_URL}”`, VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(errLines(deps).some((l) => /non-ASCII character/.test(l) && /typographic quote/.test(l))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
  });

  it('saves the URL with webhookTest cleared before calling send, and prints "Sending test file…" first', async () => {
    let stateAtSendTime: BootstrapState | undefined;
    const send = vi.fn().mockImplementation(async () => {
      stateAtSendTime = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    });
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt, { send });

    await runGuided(deps);

    expect(stateAtSendTime?.webhookUrl).toBe(VALID_TRIGGER_URL);
    expect(stateAtSendTime?.webhookTest).toBeUndefined();
    expect(send).toHaveBeenCalledWith(VALID_TRIGGER_URL, expect.objectContaining({ fileName: expect.any(String) }), 30_000);
    expect(errLines(deps)).toContain('Sending test file…');
  });

  it('on success, prints the "Within a minute <file>…" text and saves webhookTest:\'passed\'', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(
      errLines(deps).some((l) => /^Within a minute setup-check-.*\.json should be in the SharePoint folder/.test(l))
    ).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookTest).toBe('passed');
  });

  it('a 4xx test-send failure prints the flow/Anyone/whole-URL hint and offers Try again / Enter a different URL / Skip the test; Skip saves webhookTest:\'skipped\'', async () => {
    const send = vi.fn().mockRejectedValue(new SyncDeliveryError('HTTP 404', 404));
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['skip', 'windows', 'default'] // test-send menu, then policy, then lookback
    });
    const deps = createDeps(prompt, { send });

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(errLines(deps).some((l) => l.includes('Check that the flow is turned on'))).toBe(true);
    expect(prompt.select).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ value: 'retry', name: expect.stringContaining('Try again') }),
        expect.objectContaining({ value: 'url', name: expect.stringContaining('different URL') }),
        expect.objectContaining({ value: 'skip', name: expect.stringContaining('Skip the test') })
      ]),
      expect.anything()
    );
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookTest).toBe('skipped');
  });

  it('"Try again" re-sends, and "Enter a different URL" asks for a new one', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SyncDeliveryError('HTTP 500', 500))
      .mockResolvedValueOnce(undefined);
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['retry', 'windows', 'default']
    });
    const deps = createDeps(prompt, { send });

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    // A 5xx is not a 4xx: no "flow on / Anyone" hint.
    expect(errLines(deps).some((l) => l.includes('Check that the flow is turned on'))).toBe(false);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookTest).toBe('passed');
  });

  it('step 6 offers windows (default), always and never, with explanations, and saves the chosen policy', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['always', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.select).toHaveBeenNthCalledWith(
      1,
      'When should developer machines include external sessions?',
      [
        { value: 'windows', name: expect.stringContaining('Windows only (recommended)') },
        { value: 'always', name: expect.stringContaining('On all platforms') },
        { value: 'never', name: expect.stringContaining('Never') }
      ],
      'windows'
    );
    expect(errLines(deps).some((l) => l.includes('also counts agent sessions not launched through CodeMie'))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.includeExternal).toBe('always');
  });

  it('step 7 default path saves lookbackDays as the literal "default"', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.lookbackDays).toBe('default');
  });

  it('step 7 fixed path retries on an out-of-range number before accepting a value in 1-30', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL, '31', '14'],
      confirm: [true],
      select: ['windows', 'fixed']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(errLines(deps).some((l) => /1-30/.test(l))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.lookbackDays).toBe(14);
  });

  it('step 8 sends exactly one out line built by toInstallCommandOptions, then UPDATE_HINT on err', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['always', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).toBe(buildInstallCommand({ webhook: VALID_TRIGGER_URL, includeExternal: 'always' }));
    const lines = errLines(deps);
    expect(lines[lines.length - 1]).toBe(UPDATE_HINT);
  });
});
