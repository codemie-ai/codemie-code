/**
 * `recordConnectConsent`: the work consent `proxy connect` records after the Claude Code writer succeeded.
 * Real consent store over a temp home; only the identity, the project root and the project resolution are faked.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tempDir: string;
let work: string;
const identityMock = vi.fn();
const projectMock = vi.fn();

vi.mock('@/utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return { ...actual, getCodemiePath: (...p: string[]) => join(tempDir, ...p), resolveHomeDir: (r = '') => join(tempDir, 'home', r) };
});
vi.mock('@/utils/project-root.js', () => ({ resolveProjectRoot: () => work }));
vi.mock('@/agents/core/evidence/hook-identity.js', () => ({ currentEvidenceIdentity: identityMock }));
vi.mock('../consent-project.js', () => ({ resolveConsentProject: projectMock }));

const id = { api_identity: 'https://api.example.com', owner_hash: 'o'.repeat(64) };

describe('recordConnectConsent', () => {
  let out: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'codemie-connect-consent-')));
    work = join(tempDir, 'repo');
    await mkdir(work, { recursive: true });
    identityMock.mockReset().mockResolvedValue(id);
    projectMock.mockReset().mockResolvedValue('Secret-Project-Name');
    out = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    await (await import('@/utils/logger.js')).logger.close();
    vi.restoreAllMocks();
    vi.resetModules();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const printed = (): string[] => out.mock.calls.map(([line]) => stripAnsi(String(line)));
  const entries = async (): Promise<Array<Record<string, unknown>>> => {
    const { consentStorePath } = await import('@/agents/core/evidence/consent-store.js');
    return readFile(consentStorePath(), 'utf-8').then((s) => (JSON.parse(s) as { entries: Array<Record<string, unknown>> }).entries, () => []);
  };

  it('user scope records the all-repositories consent and prints the exact line', async () => {
    const { recordConnectConsent } = await import('../connect-consent.js');

    const result = await recordConnectConsent('user');

    expect(result.ok).toBe(true);
    expect(printed()).toEqual([
      '✓ Analytics from personal Claude subscriptions will be sent for any repository (applies to new sessions only).',
      '  Sessions already held for lack of consent: codemie proxy analytics resend',
    ]);
    expect(await entries()).toEqual([expect.objectContaining({ all_folders: true, owner_hash: id.owner_hash, api_identity: id.api_identity })]);
  });

  it('project scope records the repository root with the resolved project, and names neither', async () => {
    const { recordConnectConsent } = await import('../connect-consent.js');

    const result = await recordConnectConsent('project');

    expect(result.ok).toBe(true);
    expect(projectMock).toHaveBeenCalledWith(work);
    expect(printed()).toEqual([
      '✓ Analytics from personal Claude subscriptions will be sent for this repository (applies to new sessions only).',
      '  Sessions already held for lack of consent: codemie proxy analytics resend',
    ]);
    expect(printed().join('\n')).not.toContain('Secret-Project-Name');
    expect(printed().join('\n')).not.toContain(work);
    expect(await entries()).toEqual([expect.objectContaining({ project: 'Secret-Project-Name', folder: work })]);
  });

  it.each([
    ['user', 'consent grant --all'],
    ['project', 'consent grant'],
  ] as const)('a failed write (%s scope) is a failed result with the message and the command to run', async (scope, command) => {
    identityMock.mockResolvedValue(null);
    const { recordConnectConsent } = await import('../connect-consent.js');

    const result = await recordConnectConsent(scope);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Sign in');
    const lines = printed();
    expect(lines[0]).toMatch(/^ {2}Could not enable analytics from personal Claude subscriptions: .*Sign in/);
    expect(lines[1]).toBe(`  the consent was not recorded — run: codemie proxy analytics ${command}`);
    expect(await entries()).toEqual([]);
  });

  it('an unresolvable project (project scope) is a failed result, nothing recorded', async () => {
    projectMock.mockRejectedValue(new Error('No CodeMie project resolved for this folder.'));
    const { recordConnectConsent } = await import('../connect-consent.js');

    const result = await recordConnectConsent('project');

    expect(result.ok).toBe(false);
    expect(printed()[0]).toContain('Could not enable analytics from personal Claude subscriptions: No CodeMie project resolved');
    expect(await entries()).toEqual([]);
  });

  it.each([
    ['project', '  To send analytics from personal Claude subscriptions in this repository later, run in the repository: codemie proxy analytics consent grant (applies to new sessions only)'],
    ['user', '  To send analytics from personal Claude subscriptions in any repository later, run: codemie proxy analytics consent grant --all (applies to new sessions only)'],
  ] as const)('prints the "enable later" hint of the %s scope', async (scope, line) => {
    const { printEnableLaterHint } = await import('../connect-consent.js');

    printEnableLaterHint(scope);

    expect(printed()).toEqual([line]);
  });
});
