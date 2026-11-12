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

import { readFileSync } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDeliveryError } from '@/utils/errors.js';

import { buildInstallCommand } from '../../install-command.js';
import { updateHint } from '../setup-check.js';
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

// The git test push really pushes to a remote; the guided flow's own wiring (ask, save,
// loop on 'retry') is what these tests cover, so only `testGitCheck` is replaced.
// `askGitDetails` stays real, so its validators drive the prompts.
const testGitCheckMock = vi.hoisted(() => vi.fn());
vi.mock('../git-step.js', async () => {
  const actual = await vi.importActual<typeof import('../git-step.js')>('../git-step.js');
  return {
    ...actual,
    testGitCheck: (...args: unknown[]) => testGitCheckMock(...args)
  };
});

import { runGuided } from '../guided.js';

const VALID_CHANNEL_LINK =
  'https://teams.microsoft.com/l/channel/19%3Aabc123%40thread.tacv2/General?groupId=11111111-2222-3333-4444-555555555555';
const MESSAGE_LINK = 'https://teams.microsoft.com/l/message/abc123?groupId=11111111-2222-3333-4444-555555555555';
const VALID_FOLDER_URL = 'https://contoso.sharepoint.com/sites/Analytics/Shared%20Documents/CodeMie?id=%2Fsites%2FAnalytics%2FShared%20Documents%2FCodeMie';
const VALID_TRIGGER_URL = 'https://example.invalid/triggers/invoke?api-version=1&sig=FAKESECRET';
const VALID_GIT_REPO = 'git@github.com:contoso/analytics.git';
const D8_NOTE = "Push access comes from each developer's own SSH key or credential helper, verified by install.";

/** A fully-answered state (steps 1-7) `checkReuse` should accept as reusable. */
const COMPLETE_STATE: BootstrapState = {
  version: 2,
  targets: { webhook: true, git: false },
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
      cliVersion: async () => '0.17.0',
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
      select: overrides.select ?? ['webhook', 'windows', 'default']
    });
  }

  it('prints each step heading once, in order, even after a rejected channel confirm', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      // already-imported:no, channel-confirm:no (retry), channel-confirm:yes, folder-confirm:yes,
      // open-browser:yes, press-enter:yes
      confirm: [false, false, true, true, true, true],
      select: ['webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const lines = errLines(deps);
    const headingLines = lines.filter((l) => /^Step \d+ of \d+ · /.test(l));
    expect(headingLines).toEqual([
      'Step 1 of 9 · Delivery target',
      'Step 2 of 9 · Teams channel',
      'Step 3 of 9 · SharePoint folder',
      'Step 4 of 9 · Time zone',
      'Step 5 of 9 · Import the flow',
      'Step 6 of 9 · Trigger URL',
      'Step 7 of 9 · External sessions',
      'Step 8 of 9 · Lookback',
      'Step 9 of 9 · Developers'
    ]);
  });

  it('asks again on a /l/message/ Teams link, then accepts a valid one', async () => {
    const prompt = createScriptedPrompt({
      input: [MESSAGE_LINK, VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: [false, true, true, true, true],
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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

  it('step 4 writes the answers from steps 1-3 into Flow_config.inputs, keeping the template-only keys', async () => {
    const deps = createDeps(freshRunScript());

    await runGuided(deps);

    const entries = unzipSync(readFileSync(join(dir, 'codemie-analytics-flow.zip')));
    const definitionName = Object.keys(entries).find((name) => name.endsWith('/definition.json')) ?? '';
    const definition = JSON.parse(Buffer.from(entries[definitionName]).toString('utf-8'));
    expect(definition.properties.definition.actions.Flow_config.inputs).toEqual({
      siteUrl: 'https://contoso.sharepoint.com/sites/Analytics',
      folderPath: 'Shared Documents/CodeMie',
      teamId: '11111111-2222-3333-4444-555555555555',
      channelId: '19:abc123@thread.tacv2',
      timeZone: 'UTC',
      threadKeyPrefix: 'analytics-thread',
      recentCount: 10
    });
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
      select: ['webhook', 'windows', 'default']
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
    const prompt = createScriptedPrompt({ select: ['webhook'], confirm: [false] });
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
      select: ['webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
    const lines = errLines(deps);
    expect(lines).toContain('Step 6 of 9 · Trigger URL');
    expect(lines.some((l) => /not available yet/i.test(l))).toBe(false);
  });

  it('with a reusable saved state, shows the masked summary and accepting jumps to step 8', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(prompt.input).not.toHaveBeenCalled();
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(prompt.select).toHaveBeenCalledTimes(1);
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
      select: ['reuse', 'windows', 'default']
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
      input: [VALID_CHANNEL_LINK, 'UTC', VALID_TRIGGER_URL],
      confirm: [
        true, // channel confirm
        true, // keep the saved SharePoint folder
        true, // open browser
        true // press enter
      ],
      select: ['restart', 'webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.input).toHaveBeenNthCalledWith(1, expect.stringContaining('Teams channel link'), COMPLETE_STATE.channelLink);
  });

  it('step 2 offers the saved SharePoint folder back; keeping it skips the paste', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, 'UTC', VALID_TRIGGER_URL],
      confirm: [true, true, true, true],
      select: ['restart', 'webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(prompt.confirm).toHaveBeenNthCalledWith(2, expect.stringContaining(COMPLETE_STATE.siteUrl ?? ''), true);
    const inputMessages = (prompt.input as ReturnType<typeof vi.fn>).mock.calls.map(([message]: [string]) => message);
    expect(inputMessages.some((message) => message.includes('SharePoint folder'))).toBe(false);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.siteUrl).toBe(COMPLETE_STATE.siteUrl);
    expect(saved.folderPath).toBe(COMPLETE_STATE.folderPath);
  });

  it('step 2 asks for a fresh paste when the lead does not keep the saved folder', async () => {
    await saveBootstrapState({ ...COMPLETE_STATE, folderPath: 'Shared Documents/Old' }, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      // channel:yes, keep saved folder:no, pasted folder confirm:yes, open browser, press enter
      confirm: [true, false, true, true, true],
      select: ['restart', 'webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.folderPath).toBe('Shared Documents/CodeMie');
  });

  it('declining reuse discards the saved webhook before steps 1-4 run again', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    // Start over — then the scripted prompter runs dry at step 1, as if the lead quit there.
    const prompt = createScriptedPrompt({ select: ['restart', 'webhook'] });
    const deps = createDeps(prompt);

    await expect(runGuided(deps)).rejects.toThrow(/ran out/);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookUrl).toBeUndefined();
    expect(saved.webhookTest).toBeUndefined();
    expect(saved.teamId).toBe(COMPLETE_STATE.teamId);
  });

  it('a reuse check that resumes at step 4 discards the saved webhook', async () => {
    const { flowImported: _flowImported, ...notImported } = COMPLETE_STATE;
    await saveBootstrapState(notImported, statePath);
    // Reuse — resumes at step 4, then the prompter runs dry at "Open … in your browser?".
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt);

    await expect(runGuided(deps)).rejects.toThrow(/ran out/);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookUrl).toBeUndefined();
    expect(saved.webhookTest).toBeUndefined();
  });

  it('a state saved via the "already imported" shortcut is reusable on the next run', async () => {
    const first = createDeps(
      createScriptedPrompt({ input: [VALID_TRIGGER_URL], confirm: [true], select: ['webhook', 'windows', 'default'] })
    );
    expect(await runGuided(first)).toBe(0);

    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const second = createDeps(prompt);

    expect(await runGuided(second)).toBe(0);
    expect(prompt.input).not.toHaveBeenCalled();
    expect(second.out).toHaveBeenCalledWith(buildInstallCommand({ webhook: VALID_TRIGGER_URL, includeExternal: 'windows' }));
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

  /** A fresh-state `BootstrapDeps`. Every script here starts with the `'webhook'` target
   * choice (the first `select` answer), then wires `prompt.confirm`'s first answer to
   * "already imported the flow?" so the run jumps straight to the trigger-URL step — no
   * saved state, so the webhook setup steps are skipped and no `input` answer is consumed
   * before the trigger-URL step's own prompts. */
  function createDeps(prompt: BootstrapPrompter, overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
    return {
      isTTY: true,
      cwd: dir,
      now: () => new Date('2026-11-04T21:33:07.123Z'),
      cliVersion: async () => '0.17.0',
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'skip', 'windows', 'default'] // test-send menu, then policy, then lookback
    });
    const deps = createDeps(prompt, { send });

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(errLines(deps).some((l) => l.includes('Check that the flow is turned on'))).toBe(true);
    expect(prompt.select).toHaveBeenNthCalledWith(
      2,
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

  it('"Try again" re-sends the same URL', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SyncDeliveryError('HTTP 500', 500))
      .mockResolvedValueOnce(undefined);
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'retry', 'windows', 'default']
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

  it('"Enter a different URL" asks for a new URL, saves it, and test-sends that one', async () => {
    const otherUrl = 'https://example.invalid/triggers/invoke?api-version=1&sig=OTHERSECRET';
    const send = vi
      .fn()
      .mockRejectedValueOnce(new SyncDeliveryError('HTTP 404', 404))
      .mockResolvedValueOnce(undefined);
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL, otherUrl],
      confirm: [true],
      select: ['webhook', 'url', 'windows', 'default']
    });
    const deps = createDeps(prompt, { send });

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(prompt.input).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(otherUrl, expect.anything(), 30_000);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.webhookUrl).toBe(otherUrl);
    expect(saved.webhookTest).toBe('passed');
    expect(errLines(deps).filter((l) => l === 'Step 6 of 9 · Trigger URL')).toHaveLength(1);
    expect(deps.out).toHaveBeenCalledWith(buildInstallCommand({ webhook: otherUrl, includeExternal: 'windows' }));
  });

  it('step 6 offers never (default), always and windows, with explanations, and saves the chosen policy', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'always', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.select).toHaveBeenNthCalledWith(
      2,
      'When should developer machines include external sessions?',
      [
        { value: 'never', name: expect.stringContaining('Never (recommended)') },
        { value: 'always', name: expect.stringContaining('On all platforms') },
        { value: 'windows', name: expect.stringContaining('Windows only') }
      ],
      'never'
    );
    expect(errLines(deps).some((l) => l.includes('also counts agent sessions not launched through CodeMie'))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.includeExternal).toBe('always');
  });

  it('step 7 default path saves lookbackDays as the literal "default"', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'windows', 'default']
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
      select: ['webhook', 'windows', 'fixed']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(errLines(deps).some((l) => /1-30/.test(l))).toBe(true);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.lookbackDays).toBe(14);
  });

  it('step 8 sends exactly one out line built by toInstallCommandOptions, then the versioned update hint on err', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'always', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(deps.out).toHaveBeenCalledTimes(1);
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).toBe(buildInstallCommand({ webhook: VALID_TRIGGER_URL, includeExternal: 'always' }));
    const lines = errLines(deps);
    expect(lines[lines.length - 1]).toBe(updateHint('0.17.0'));
  });
});

describe('runGuided — delivery target selection', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testGitCheckMock.mockResolvedValue('passed');
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
      cliVersion: async () => '0.17.0',
      out: vi.fn(),
      err: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
      prompt,
      statePath,
      ...overrides
    };
  }

  function headings(deps: BootstrapDeps): string[] {
    return errLines(deps).filter((l) => /^Step \d+ of \d+ · /.test(l));
  }

  it('the first prompt of a fresh run is the delivery target choice: webhook, git or both', async () => {
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(prompt.select).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      [
        expect.objectContaining({ value: 'webhook' }),
        expect.objectContaining({ value: 'git' }),
        expect.objectContaining({ value: 'both' })
      ],
      expect.anything()
    );
  });

  it('saves the target choice right away: an interrupt after a git-only choice leaves it on disk (AC23)', async () => {
    const prompt = createScriptedPrompt({ select: ['git'] });

    await expect(runGuided(createDeps(prompt))).rejects.toThrow(/ran out of input/);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved).toEqual({ version: 2, targets: { webhook: false, git: true } });
  });

  it('saves the target choice right away on a webhook run answered "not imported" (AC23)', async () => {
    const prompt = createScriptedPrompt({ select: ['both'], confirm: [false] });

    await expect(runGuided(createDeps(prompt))).rejects.toThrow(/ran out of input/);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved).toEqual({ version: 2, targets: { webhook: true, git: true } });
  });

  it('a fresh git-only run asks the target, then only git-repo/external/lookback/developers, as "Step N of 5"', async () => {
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(headings(deps)).toEqual([
      'Step 1 of 5 · Delivery target',
      'Step 2 of 5 · Git repository',
      'Step 3 of 5 · External sessions',
      'Step 4 of 5 · Lookback',
      'Step 5 of 5 · Developers'
    ]);
    // No "already imported the flow?" question: git-only has no flow.
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(testGitCheckMock).toHaveBeenCalledTimes(1);
    expect(testGitCheckMock).toHaveBeenCalledWith(deps, { repoUrl: VALID_GIT_REPO }, undefined);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.targets).toEqual({ webhook: false, git: true });
    expect(saved.gitRepoUrl).toBe(VALID_GIT_REPO);
    expect(saved.gitTest).toBe('passed');
    expect(saved.webhookUrl).toBeUndefined();
  });

  it('empty branch and path produce no --git-branch / --git-path token in the install command', async () => {
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(deps.out).toHaveBeenCalledTimes(1);
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).toBe(buildInstallCommand({ gitRepo: VALID_GIT_REPO, includeExternal: 'windows' }));
    expect(outLine).toContain('--git-repo');
    expect(outLine).not.toContain('--git-branch');
    expect(outLine).not.toContain('--git-path');
    expect(outLine).not.toContain('--webhook-b64');
  });

  it('a git-only run prints the developer push-access note after the install command', async () => {
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    await runGuided(deps);

    const lines = errLines(deps);
    expect(lines).toContain(D8_NOTE);
    expect(lines[lines.length - 1]).toBe(updateHint('0.17.0'));
  });

  it('a webhook-only run does not print the developer push-access note', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(errLines(deps)).not.toContain(D8_NOTE);
  });

  it('a fresh webhook-only run numbers its steps "of 9", with the target step first', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL],
      confirm: [true],
      select: ['webhook', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(headings(deps)).toEqual([
      'Step 1 of 9 · Delivery target',
      'Step 6 of 9 · Trigger URL',
      'Step 7 of 9 · External sessions',
      'Step 8 of 9 · Lookback',
      'Step 9 of 9 · Developers'
    ]);
    expect(testGitCheckMock).not.toHaveBeenCalled();
  });

  it('a both-targets run asks the trigger URL, then the git repository, and prints both --webhook-b64 and --git-repo', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_TRIGGER_URL, VALID_GIT_REPO, 'main', 'reports/codemie'],
      confirm: [true], // already imported the flow? yes
      select: ['both', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    const exit = await runGuided(deps);

    expect(exit).toBe(0);
    expect(headings(deps)).toEqual([
      'Step 1 of 10 · Delivery target',
      'Step 6 of 10 · Trigger URL',
      'Step 7 of 10 · Git repository',
      'Step 8 of 10 · External sessions',
      'Step 9 of 10 · Lookback',
      'Step 10 of 10 · Developers'
    ]);
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).toBe(
      buildInstallCommand({
        webhook: VALID_TRIGGER_URL,
        gitRepo: VALID_GIT_REPO,
        gitBranch: 'main',
        gitPath: 'reports/codemie',
        includeExternal: 'windows'
      })
    );
    expect(outLine).toContain('--webhook-b64');
    expect(outLine).toContain('--git-repo');
    expect(errLines(deps)).toContain(D8_NOTE);
  });

  it('a fresh both-targets run without the shortcut walks all 10 steps in order', async () => {
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL, VALID_GIT_REPO, '', ''],
      confirm: [false, true, true, true, true],
      select: ['both', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)).toEqual([
      'Step 1 of 10 · Delivery target',
      'Step 2 of 10 · Teams channel',
      'Step 3 of 10 · SharePoint folder',
      'Step 4 of 10 · Time zone',
      'Step 5 of 10 · Import the flow',
      'Step 6 of 10 · Trigger URL',
      'Step 7 of 10 · Git repository',
      'Step 8 of 10 · External sessions',
      'Step 9 of 10 · Lookback',
      'Step 10 of 10 · Developers'
    ]);
  });

  it('"Enter different repository details" asks for the git details again, printing the heading once', async () => {
    testGitCheckMock.mockResolvedValueOnce('retry').mockResolvedValueOnce('passed');
    const otherRepo = 'git@github.com:contoso/other.git';
    const prompt = createScriptedPrompt({
      input: [VALID_GIT_REPO, '', '', otherRepo, '', ''],
      select: ['git', 'windows', 'default']
    });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(testGitCheckMock).toHaveBeenCalledTimes(2);
    expect(testGitCheckMock).toHaveBeenLastCalledWith(deps, { repoUrl: otherRepo }, undefined);
    expect(errLines(deps).filter((l) => l === 'Step 2 of 5 · Git repository')).toHaveLength(1);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.gitRepoUrl).toBe(otherRepo);
    expect(saved.gitTest).toBe('passed');
  });

  it('saves the git details with gitTest cleared before the test push', async () => {
    let stateAtTestTime: BootstrapState | undefined;
    testGitCheckMock.mockImplementationOnce(async () => {
      stateAtTestTime = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
      return 'skipped';
    });
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, 'main', ''], select: ['git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    await runGuided(deps);

    expect(stateAtTestTime?.gitRepoUrl).toBe(VALID_GIT_REPO);
    expect(stateAtTestTime?.gitBranch).toBe('main');
    expect(stateAtTestTime?.gitTest).toBeUndefined();
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.gitTest).toBe('skipped');
  });

  const GIT_ONLY_STATE: BootstrapState = {
    version: 2,
    targets: { webhook: false, git: true },
    gitRepoUrl: VALID_GIT_REPO,
    gitBranch: 'main',
    gitTest: 'passed',
    includeExternal: 'never',
    lookbackDays: 'default'
  };

  it('a reusable saved git-only state is offered for reuse (not treated as fresh) and jumps to the install command', async () => {
    await saveBootstrapState(GIT_ONLY_STATE, statePath);
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(prompt.select).toHaveBeenCalledTimes(1);
    expect(prompt.input).not.toHaveBeenCalled();
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(deps.out).toHaveBeenCalledWith(
      buildInstallCommand({ gitRepo: VALID_GIT_REPO, gitBranch: 'main', includeExternal: 'never' })
    );
    expect(headings(deps)).toEqual(['Step 5 of 5 · Developers']);
  });

  it('starting over on a saved git-only state re-asks the target, offering git, and keeps git-only when confirmed', async () => {
    await saveBootstrapState(GIT_ONLY_STATE, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_GIT_REPO, '', ''],
      select: ['restart', 'git', 'never', 'default']
    });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(prompt.select).toHaveBeenNthCalledWith(2, expect.stringContaining('deliver'), expect.any(Array), 'git');
    expect(headings(deps).slice(0, 2)).toEqual(['Step 1 of 5 · Delivery target', 'Step 2 of 5 · Git repository']);
    // The stale git answers were discarded, so the saved branch is not offered back.
    expect(prompt.input).toHaveBeenNthCalledWith(2, expect.stringContaining('Branch'), undefined);
  });

  it('starting over on a saved git-only state can add the webhook target, asking its steps from the first', async () => {
    await saveBootstrapState(GIT_ONLY_STATE, statePath);
    // Start over, choose both — then the prompter runs dry at the Teams channel step.
    const prompt = createScriptedPrompt({ select: ['restart', 'both'] });
    const deps = createDeps(prompt);

    await expect(runGuided(deps)).rejects.toThrow(/ran out/);

    expect(prompt.select).toHaveBeenNthCalledWith(2, expect.stringContaining('deliver'), expect.any(Array), 'git');
    expect(headings(deps)).toEqual(['Step 1 of 10 · Delivery target', 'Step 2 of 10 · Teams channel']);
    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.targets).toEqual({ webhook: true, git: true });
  });

  it('a saved git-only state with an untested repository resumes at the git step, discarding the stale git answers', async () => {
    const { gitTest: _gitTest, ...untested } = GIT_ONLY_STATE;
    await saveBootstrapState(untested, statePath);
    // Reuse — resumes at git-repo, then the prompter runs dry at the repo URL prompt.
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt);

    await expect(runGuided(deps)).rejects.toThrow(/ran out/);

    const saved = JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
    expect(saved.gitRepoUrl).toBeUndefined();
    expect(saved.gitBranch).toBeUndefined();
    expect(saved.gitTest).toBeUndefined();
    expect(saved.includeExternal).toBe('never');
    expect(headings(deps)).toEqual(['Step 2 of 5 · Git repository']);
  });
});

describe('runGuided — saved setup: Reuse / Change targets / Start over', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    testGitCheckMock.mockReset();
    testGitCheckMock.mockResolvedValue('passed');
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
      cliVersion: async () => '0.17.0',
      out: vi.fn(),
      err: vi.fn(),
      send: vi.fn().mockResolvedValue(undefined),
      openUrl: vi.fn().mockResolvedValue(undefined),
      prompt,
      statePath,
      ...overrides
    };
  }

  function headings(deps: BootstrapDeps): string[] {
    return errLines(deps).filter((l) => /^Step \d+ of \d+ · /.test(l));
  }

  async function loadSaved(): Promise<BootstrapState> {
    return JSON.parse(await readFile(statePath, 'utf-8')) as BootstrapState;
  }

  const GIT_ONLY: BootstrapState = {
    version: 2,
    targets: { webhook: false, git: true },
    gitRepoUrl: VALID_GIT_REPO,
    gitBranch: 'main',
    gitTest: 'passed',
    includeExternal: 'never',
    lookbackDays: 'default'
  };

  const BOTH: BootstrapState = {
    ...COMPLETE_STATE,
    targets: { webhook: true, git: true },
    gitRepoUrl: VALID_GIT_REPO,
    gitBranch: 'main',
    gitTest: 'passed'
  };

  it('a saved git-only setup opens with its summary and the three-way menu, not the flow-import question (AC21)', async () => {
    await saveBootstrapState(GIT_ONLY, statePath);
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(prompt.select).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      [
        expect.objectContaining({ value: 'reuse', name: expect.stringContaining('Reuse') }),
        expect.objectContaining({ value: 'change', name: expect.stringContaining('Change targets') }),
        expect.objectContaining({ value: 'restart', name: expect.stringContaining('Start over') })
      ],
      'reuse'
    );
    const lines = errLines(deps);
    expect(lines).toContain('  Delivery targets: webhook off, git on');
    expect(lines).toContain('  Git repository: github.com/… (path hidden)');
    expect(lines.join('\n')).not.toContain('contoso/analytics');
  });

  it('Reuse live re-checks every chosen target before printing, saving each outcome', async () => {
    await saveBootstrapState({ ...BOTH, webhookTest: 'skipped', gitTest: 'skipped' }, statePath);
    const order: string[] = [];
    const send = vi.fn().mockImplementation(async () => {
      order.push('send');
    });
    testGitCheckMock.mockImplementation(async () => {
      order.push('git');
      return 'passed';
    });
    const prompt = createScriptedPrompt({ select: ['reuse'] });
    const deps = createDeps(prompt, {
      send,
      out: vi.fn(() => {
        order.push('out');
      })
    });

    expect(await runGuided(deps)).toBe(0);

    expect(order).toEqual(['send', 'git', 'out']);
    expect(send).toHaveBeenCalledWith(VALID_TRIGGER_URL, expect.anything(), 30_000);
    expect(testGitCheckMock).toHaveBeenCalledWith(deps, { repoUrl: VALID_GIT_REPO, branch: 'main' }, undefined);
    const saved = await loadSaved();
    expect(saved.webhookTest).toBe('passed');
    expect(saved.gitTest).toBe('passed');
    expect(headings(deps)).toEqual(['Step 10 of 10 · Developers']);
  });

  it('Reuse: a skipped live webhook re-check still prints, saving webhookTest:"skipped"', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const send = vi.fn().mockRejectedValue(new SyncDeliveryError('HTTP 404', 404));
    const prompt = createScriptedPrompt({ select: ['reuse', 'skip'] });
    const deps = createDeps(prompt, { send });

    expect(await runGuided(deps)).toBe(0);

    expect(deps.out).toHaveBeenCalledTimes(1);
    expect((await loadSaved()).webhookTest).toBe('skipped');
  });

  it('Reuse: "Enter a different URL" on the live webhook re-check resumes at the Trigger URL step', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const otherUrl = 'https://example.invalid/triggers/invoke?api-version=1&sig=OTHERSECRET';
    const send = vi.fn().mockRejectedValueOnce(new SyncDeliveryError('HTTP 404', 404)).mockResolvedValue(undefined);
    const prompt = createScriptedPrompt({ input: [otherUrl], select: ['reuse', 'url', 'windows', 'default'] });
    const deps = createDeps(prompt, { send });

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)[0]).toBe('Step 6 of 9 · Trigger URL');
    expect(deps.out).toHaveBeenCalledWith(buildInstallCommand({ webhook: otherUrl, includeExternal: 'windows' }));
    expect((await loadSaved()).webhookUrl).toBe(otherUrl);
  });

  it('Reuse: "Enter different repository details" on the live git re-check resumes at the Git repository step', async () => {
    await saveBootstrapState(GIT_ONLY, statePath);
    testGitCheckMock.mockResolvedValueOnce('retry').mockResolvedValue('passed');
    const otherRepo = 'git@github.com:contoso/other.git';
    const prompt = createScriptedPrompt({ input: [otherRepo, '', ''], select: ['reuse', 'never', 'default'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)[0]).toBe('Step 2 of 5 · Git repository');
    expect(deps.out).toHaveBeenCalledWith(buildInstallCommand({ gitRepo: otherRepo, includeExternal: 'never' }));
  });

  it('Reuse on a both-targets setup with a credential-bearing saved git URL resumes at the Git repository step, never printing it (AR-2/D15)', async () => {
    await saveBootstrapState({ ...BOTH, gitRepoUrl: 'https://tok@github.com/contoso/analytics.git' }, statePath);
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['reuse', 'windows', 'default'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)[0]).toBe('Step 7 of 10 · Git repository');
    expect(testGitCheckMock).toHaveBeenCalledTimes(1);
    expect(testGitCheckMock).toHaveBeenCalledWith(deps, { repoUrl: VALID_GIT_REPO }, undefined);
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).toContain('--git-repo');
    expect([...errLines(deps), outLine].join('\n')).not.toContain('tok@');
  });

  it('Change targets, adding git over a retained credential-bearing git URL, never offers it as a prompt default (CR-003)', async () => {
    await saveBootstrapState({ ...COMPLETE_STATE, gitRepoUrl: 'https://tok@github.com/contoso/analytics.git' }, statePath);
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['change', 'both'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    const gitPrompt = (prompt.input as ReturnType<typeof vi.fn>).mock.calls.find(([message]: [string]) =>
      message.startsWith('Git repository URL')
    );
    expect(gitPrompt?.[1]).toBeUndefined();
    expect((deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain('tok@');
  });

  it('Change targets, adding git to a saved webhook-only setup, asks only git questions and prints both targets (AC19)', async () => {
    await saveBootstrapState(COMPLETE_STATE, statePath);
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, 'main', ''], select: ['change', 'both'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)).toEqual([
      'Step 1 of 10 · Delivery target',
      'Step 7 of 10 · Git repository',
      'Step 10 of 10 · Developers'
    ]);
    expect(prompt.confirm).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(testGitCheckMock).toHaveBeenCalledTimes(1);
    expect(deps.out).toHaveBeenCalledWith(
      buildInstallCommand({
        webhook: VALID_TRIGGER_URL,
        gitRepo: VALID_GIT_REPO,
        gitBranch: 'main',
        includeExternal: 'windows',
        lookbackDays: 7
      })
    );
    const saved = await loadSaved();
    expect(saved.targets).toEqual({ webhook: true, git: true });
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
    expect(saved.teamId).toBe(COMPLETE_STATE.teamId);
  });

  it('Change targets, adding the webhook to a saved git-only setup, runs only the webhook steps', async () => {
    await saveBootstrapState(GIT_ONLY, statePath);
    const prompt = createScriptedPrompt({
      input: [VALID_CHANNEL_LINK, VALID_FOLDER_URL, 'UTC', VALID_TRIGGER_URL],
      confirm: [true, true, true, true],
      select: ['change', 'both']
    });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)).toEqual([
      'Step 1 of 10 · Delivery target',
      'Step 2 of 10 · Teams channel',
      'Step 3 of 10 · SharePoint folder',
      'Step 4 of 10 · Time zone',
      'Step 5 of 10 · Import the flow',
      'Step 6 of 10 · Trigger URL',
      'Step 10 of 10 · Developers'
    ]);
    expect(testGitCheckMock).not.toHaveBeenCalled();
    expect(deps.out).toHaveBeenCalledWith(
      buildInstallCommand({
        webhook: VALID_TRIGGER_URL,
        gitRepo: VALID_GIT_REPO,
        gitBranch: 'main',
        includeExternal: 'never'
      })
    );
  });

  it('turning webhook off keeps webhookUrl on disk but omits it from the print and from the next Reuse check (AC20)', async () => {
    await saveBootstrapState(BOTH, statePath);
    const first = createDeps(createScriptedPrompt({ select: ['change', 'git'] }));

    expect(await runGuided(first)).toBe(0);

    const expected = buildInstallCommand({ gitRepo: VALID_GIT_REPO, gitBranch: 'main', includeExternal: 'windows', lookbackDays: 7 });
    expect(first.out).toHaveBeenCalledWith(expected);
    expect(first.send).not.toHaveBeenCalled();
    let saved = await loadSaved();
    expect(saved.targets).toEqual({ webhook: false, git: true });
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
    expect(saved.teamId).toBe(COMPLETE_STATE.teamId);

    const second = createDeps(createScriptedPrompt({ select: ['reuse'] }));
    expect(await runGuided(second)).toBe(0);

    expect(second.send).not.toHaveBeenCalled();
    expect(second.out).toHaveBeenCalledWith(expected);
    expect((second.out as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toContain('--webhook-b64');
    expect(errLines(second)).toContain('  Delivery targets: webhook off, git on');
    saved = await loadSaved();
    expect(saved.webhookUrl).toBe(VALID_TRIGGER_URL);
  });

  it('Change targets that only removes a target still never prints a credential-bearing saved git URL', async () => {
    await saveBootstrapState({ ...BOTH, gitRepoUrl: 'https://tok@github.com/contoso/analytics.git' }, statePath);
    const prompt = createScriptedPrompt({ input: [VALID_GIT_REPO, '', ''], select: ['change', 'git', 'windows', 'default'] });
    const deps = createDeps(prompt);

    expect(await runGuided(deps)).toBe(0);

    expect(headings(deps)).toContain('Step 2 of 5 · Git repository');
    const outLine = (deps.out as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(outLine).not.toContain('tok@');
    expect((await loadSaved()).webhookUrl).toBe(VALID_TRIGGER_URL);
  });
});
