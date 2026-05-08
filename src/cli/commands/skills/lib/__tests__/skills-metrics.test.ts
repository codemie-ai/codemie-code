/**
 * Unit tests for the skill events emitter.
 *
 * Spec §8 requires:
 *   - POST to <api-base>/v1/skills/events
 *   - silent no-op when SSO credentials are missing
 *   - fan-out per skill name (one POST per skill)
 *   - SSO cookies included as Cookie header
 *   - never include source_type/source_origin/tenant labels
 *   - skill_slug mirrors upstream toSkillSlug() byte-for-byte
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStoredCredentials = vi.fn();
const mockConfigLoad = vi.fn();
const mockEnsureApiBase = vi.fn();
const mockDetectGitBranch = vi.fn();
const mockDetectGitRemote = vi.fn();

vi.mock('@/utils/config.js', () => ({
  ConfigLoader: { load: () => mockConfigLoad() },
}));

vi.mock('@/utils/processes.js', () => ({
  detectGitBranch: (...args: unknown[]) => mockDetectGitBranch(...args),
  detectGitRemoteRepo: (...args: unknown[]) => mockDetectGitRemote(...args),
}));

vi.mock('@/providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: class {
    getStoredCredentials = (...args: unknown[]) => mockGetStoredCredentials(...args);
  },
}));

vi.mock('@/providers/core/codemie-auth-helpers.js', () => ({
  ensureApiBase: (raw: string) => mockEnsureApiBase(raw),
}));

let fetchSpy: ReturnType<typeof vi.fn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockGetStoredCredentials.mockReset();
  mockConfigLoad.mockReset();
  mockEnsureApiBase.mockReset().mockImplementation((raw: string) => `${raw}/code-assistant-api`);
  mockDetectGitBranch.mockReset().mockResolvedValue('feature/test');
  mockDetectGitRemote.mockReset().mockResolvedValue('codemie-ai/codemie-code');

  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ id: 'evt-1' }),
    text: async () => '',
  });
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  delete process.env.CODEMIE_DEBUG;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  vi.resetModules();
});

async function importMetrics(): Promise<typeof import('../skills-metrics.js')> {
  vi.resetModules();
  return import('../skills-metrics.js');
}

describe('toSkillSlug', () => {
  it('mirrors upstream slugging byte-for-byte', async () => {
    const { toSkillSlug } = await importMetrics();
    expect(toSkillSlug('My Awesome Skill')).toBe('my-awesome-skill');
    expect(toSkillSlug('foo_bar baz')).toBe('foo-bar-baz');
    expect(toSkillSlug('--leading--')).toBe('leading');
    expect(toSkillSlug('UPPER/case!')).toBe('uppercase');
    expect(toSkillSlug('')).toBe('');
  });
});

describe('skill events emitter (transport behavior)', () => {
  it('is a silent no-op when no CodeMie URL is configured', async () => {
    mockConfigLoad.mockResolvedValue({});
    const { startSkillMetric, emitStarted } = await importMetrics();

    const session = await startSkillMetric('add');
    expect(session.transport).toBeNull();

    await emitStarted(session, { scope: 'project' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is a silent no-op when no SSO cookies exist', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue(null);

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('add');
    expect(session.transport).toBeNull();

    await emitStarted(session, { scope: 'project' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs a single event when no skill names are known', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('list');
    await emitStarted(session, { scope: 'global' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://codemie.lab.epam.com/code-assistant-api/v1/skills/events');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.command).toBe('list');
    expect(body.status).toBe('started');
    expect(body.scope).toBe('global');
    expect(body.agent).toBe('codemie-skills');
    expect(body.skill_name).toBeUndefined();
    expect(body.skill_slug).toBeUndefined();
    expect(body.skill_id).toBeUndefined();
    expect(body.repository).toBe('codemie-ai/codemie-code');
    expect(body.branch).toBe('feature/test');
  });

  it('fans out one POST per skill name when explicit --skill values are present', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitCompleted } = await importMetrics();
    const session = await startSkillMetric('add');
    await emitCompleted(session, {
      scope: 'project',
      source: 'owner/repo',
      skill_names: ['Foo Bar', 'baz'],
      skill_count: 2,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const bodies = fetchSpy.mock.calls.map((call) => JSON.parse(call[1].body));

    expect(bodies[0].skill_name).toBe('Foo Bar');
    expect(bodies[0].skill_slug).toBe('foo-bar');
    expect(bodies[0].skill_id).toBe('owner/repo/foo-bar');

    expect(bodies[1].skill_name).toBe('baz');
    expect(bodies[1].skill_slug).toBe('baz');
    expect(bodies[1].skill_id).toBe('owner/repo/baz');

    for (const body of bodies) {
      expect(body.command).toBe('add');
      expect(body.status).toBe('completed');
      expect(body.scope).toBe('project');
      expect(body.source).toBe('owner/repo');
    }
  });

  it('does not write command metric debug payloads directly to stderr', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitCompleted } = await importMetrics();
    const session = await startSkillMetric('add');
    await emitCompleted(session, {
      scope: 'project',
      source: 'owner/repo',
      skill_names: ['Foo Bar'],
      skill_count: 1,
    });

    expect(stderrSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('CodeMie add metric debug')
    );
  });

  it('includes SSO cookies as Cookie header on every POST', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc', other: 'def' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitFailed } = await importMetrics();
    const session = await startSkillMetric('remove');
    await emitFailed(session, { scope: 'project', error_code: 'unknown' });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers.Cookie).toMatch(/session=abc/);
    expect(init.headers.Cookie).toMatch(/other=def/);
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['X-CodeMie-Client']).toBe('codemie-cli');
  });

  it('sets repository/branch headers when git context is detected', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('list');
    await emitStarted(session, { scope: 'global' });

    const [, init] = fetchSpy.mock.calls[0]!;
    expect(init.headers['X-CodeMie-Repository']).toBe('codemie-ai/codemie-code');
    expect(init.headers['X-CodeMie-Branch']).toBe('feature/test');
  });

  it('omits repository/branch when git context is unavailable', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });
    mockDetectGitBranch.mockResolvedValue(undefined);
    mockDetectGitRemote.mockResolvedValue(undefined);

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('list');
    await emitStarted(session, { scope: 'global' });

    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init.body);
    expect(body.repository).toBeUndefined();
    expect(body.branch).toBeUndefined();
    expect(init.headers['X-CodeMie-Repository']).toBeUndefined();
    expect(init.headers['X-CodeMie-Branch']).toBeUndefined();
  });

  it('omits agent_selection_mode when wrapper does not own the selection (upstream mode)', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('add');
    await emitStarted(session, { scope: 'project' });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    // When the wrapper passes nothing through, the field is omitted entirely
    // so the backend cannot infer wrapper-known values it does not have.
    expect(body.agent_selection_mode).toBeUndefined();
    expect(body.target_agents).toBeUndefined();
  });

  it('does not emit any disallowed source-classification fields', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitCompleted } = await importMetrics();
    const session = await startSkillMetric('add');
    await emitCompleted(session, {
      scope: 'project',
      source: 'https://github.com/x/y',
      skill_names: ['s1'],
      skill_count: 1,
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.source_origin).toBeUndefined();
    expect(body.source_type).toBeUndefined();
    expect(body.selected_origin).toBeUndefined();
    expect(body.tenant).toBeUndefined();
    expect(body.client).toBeUndefined();
  });

  it('swallows POST failures so user commands are never blocked', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });
    fetchSpy.mockRejectedValueOnce(new Error('network down'));

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('list');
    // Must not throw despite the rejected fetch.
    await expect(emitStarted(session, { scope: 'global' })).resolves.toBeUndefined();
  });

  it('includes attributes JSONB payload when the find command supplies them', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitCompleted } = await importMetrics();
    const session = await startSkillMetric('find');
    await emitCompleted(session, {
      attributes: {
        query_length: 3,
        internal_available: false,
        result_count_public: 5,
      },
    });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.command).toBe('find');
    expect(body.attributes).toEqual({
      query_length: 3,
      internal_available: false,
      result_count_public: 5,
    });
    // find has no scope; the field must be absent.
    expect(body.scope).toBeUndefined();
  });

  it('omits the attributes envelope when partial.attributes is empty', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: 'https://codemie.lab.epam.com/code-assistant-api',
    });

    const { startSkillMetric, emitCompleted } = await importMetrics();
    const session = await startSkillMetric('list');
    await emitCompleted(session, { scope: 'project' });

    const body = JSON.parse(fetchSpy.mock.calls[0]![1].body);
    expect(body.attributes).toBeUndefined();
  });

  it('falls back to ensureApiBase when credentials store has no apiUrl', async () => {
    mockConfigLoad.mockResolvedValue({ codeMieUrl: 'https://codemie.lab.epam.com' });
    mockGetStoredCredentials.mockResolvedValue({
      cookies: { session: 'abc' },
      apiUrl: undefined,
    });

    const { startSkillMetric, emitStarted } = await importMetrics();
    const session = await startSkillMetric('list');
    await emitStarted(session, { scope: 'global' });

    expect(mockEnsureApiBase).toHaveBeenCalledWith('https://codemie.lab.epam.com');
    const [url] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://codemie.lab.epam.com/code-assistant-api/v1/skills/events');
  });
});
