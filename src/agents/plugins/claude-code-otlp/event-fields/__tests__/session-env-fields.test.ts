import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import os from 'node:os';

const { readFileMock, getMCPConfigSummaryMock, resolveEnvFieldsMock, getInstallationIdMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  getMCPConfigSummaryMock: vi.fn(),
  resolveEnvFieldsMock: vi.fn(),
  getInstallationIdMock: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }));
vi.mock('@/utils/mcp-config.js', () => ({ getMCPConfigSummary: getMCPConfigSummaryMock }));
vi.mock('@/utils/config.js', () => ({ getInstallationId: getInstallationIdMock }));
vi.mock('@/agents/core/event-fields/env-fields.js', () => ({ resolveEnvFields: resolveEnvFieldsMock }));
vi.mock('@/agents/plugins/claude/claude.plugin.js', () => ({ ClaudePluginMetadata: { mcpConfig: { fake: true } } }));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn() } }));

const { resolveSessionEnvFields, sessionEnvFieldsEqual } = await import('../session-env-fields.js');

/** Normalizes separators so dispatch checks work the same on win32 and posix. */
function norm(p: string): string {
  return p.split('\\').join('/');
}

/** Path never served by `readFileMock` (ENOENT) unless a test registers content for it. */
function rejectUnlessConfigured(responses: Map<string, unknown>) {
  readFileMock.mockImplementation(async (filePath: string) => {
    for (const [suffix, content] of responses) {
      if (norm(filePath).endsWith(suffix)) {
        return JSON.stringify(content);
      }
    }
    const err = new Error('ENOENT') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  });
}

const CWD = '/project';

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLAUDE_CODE_USE_BEDROCK;
  delete process.env.CLAUDE_CODE_USE_VERTEX;
  delete process.env.ANTHROPIC_BASE_URL;
  resolveEnvFieldsMock.mockResolvedValue({ os: 'linux', timezone: 'UTC' });
  getInstallationIdMock.mockResolvedValue('installation-id-1');
  getMCPConfigSummaryMock.mockResolvedValue({
    totalServers: 0,
    localServers: 0,
    projectServers: 0,
    userServers: 0,
    serverNames: [],
    localServerNames: [],
    projectServerNames: [],
    userServerNames: [],
  });
  rejectUnlessConfigured(new Map());
});

describe('resolveSessionEnvFields — provider/api_host', () => {
  it('defaults to anthropic/api.anthropic.com with no routing env vars set', async () => {
    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');
    expect(fields.provider).toBe('anthropic');
    expect(fields.api_host).toBe('api.anthropic.com');
  });

  it('reports bedrock when CLAUDE_CODE_USE_BEDROCK is set', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');
    expect(fields.provider).toBe('bedrock');
  });

  it('reports vertex when CLAUDE_CODE_USE_VERTEX is set', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1';
    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');
    expect(fields.provider).toBe('vertex');
  });

  it('reports codemie-proxy for a loopback ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:8080';
    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');
    expect(fields.provider).toBe('codemie-proxy');
    expect(fields.api_host).toBe('localhost:8080');
  });

  it('reports litellm-proxy for a non-loopback custom ANTHROPIC_BASE_URL', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://my-litellm.example.com';
    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');
    expect(fields.provider).toBe('litellm-proxy');
    expect(fields.api_host).toBe('my-litellm.example.com');
  });
});

describe('resolveSessionEnvFields — output_style cascade', () => {
  it('prefers local settings over project settings over user settings', async () => {
    rejectUnlessConfigured(
      new Map<string, unknown>([
        ['.claude/settings.local.json', { outputStyle: 'local-style' }],
        ['.claude/settings.json', { outputStyle: 'project-style' }],
      ])
    );
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.output_style).toBe('local-style');
  });

  it('falls back to project settings when local has none', async () => {
    rejectUnlessConfigured(
      new Map<string, unknown>([['.claude/settings.json', { outputStyle: 'project-style' }]])
    );
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.output_style).toBe('project-style');
  });

  it('is empty when no settings file sets outputStyle', async () => {
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.output_style).toBe('');
  });
});

describe('resolveSessionEnvFields — plugins and versions', () => {
  it('maps enabled plugin keys to their installed version, preferring the project-scoped entry', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      const p = norm(filePath);
      if (p.endsWith('.claude/settings.json') && !p.includes('/project')) {
        return JSON.stringify({ enabledPlugins: { 'superpowers@superpowers-dev': true } });
      }
      if (p.endsWith('plugins/installed_plugins.json')) {
        return JSON.stringify({
          plugins: {
            'superpowers@superpowers-dev': [
              { scope: 'user', version: '6.0.3' },
              { scope: 'project', projectPath: CWD, version: '6.0.4' },
            ],
          },
        });
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.plugins).toEqual({ 'superpowers@superpowers-dev': '6.0.4' });
  });

  it('omits a plugin with no recorded version rather than reporting an empty string', async () => {
    readFileMock.mockImplementation(async (filePath: string) => {
      const p = norm(filePath);
      if (p.endsWith('.claude/settings.json') && !p.includes('/project')) {
        return JSON.stringify({ enabledPlugins: { 'unknown@marketplace': true } });
      }
      if (p.endsWith('plugins/installed_plugins.json')) {
        return JSON.stringify({ plugins: {} });
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.plugins).toEqual({});
  });

  it('is empty when no plugin is enabled', async () => {
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.plugins).toEqual({});
  });
});

describe('resolveSessionEnvFields — mcp_servers, os/timezone, model passthrough', () => {
  it('carries getMCPConfigSummary.serverNames through verbatim', async () => {
    getMCPConfigSummaryMock.mockResolvedValue({
      totalServers: 2,
      localServers: 0,
      projectServers: 0,
      userServers: 0,
      serverNames: ['msgraph', 'codegraph'],
      localServerNames: [],
      projectServerNames: [],
      userServerNames: [],
    });
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.mcp_servers).toEqual(['msgraph', 'codegraph']);
  });

  it('reuses the shared resolveEnvFields() result for os/timezone', async () => {
    resolveEnvFieldsMock.mockResolvedValue({ os: 'darwin', timezone: 'Europe/Warsaw' });
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.os).toBe('darwin');
    expect(fields.timezone).toBe('Europe/Warsaw');
    expect(resolveEnvFieldsMock).toHaveBeenCalledTimes(1);
  });

  it('echoes configured_model/permission_mode back verbatim and always leaves effort empty', async () => {
    const fields = await resolveSessionEnvFields(CWD, 'claude-opus-5', 'acceptEdits');
    expect(fields.configured_model).toBe('claude-opus-5');
    expect(fields.permission_mode).toBe('acceptEdits');
    expect(fields.effort).toBe('');
  });

  it('fills arch/node_version from the real runtime and salts hostname_hash with the installation id', async () => {
    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');
    expect(fields.arch).toBe(process.arch);
    expect(fields.node_version).toBe(process.version);
    expect(fields.hostname_hash).toBe(createHmac('sha256', 'installation-id-1').update(os.hostname()).digest('hex'));
    // Never the unsalted digest — a common hostname would be recoverable from it.
    expect(fields.hostname_hash).not.toBe(createHash('sha256').update(os.hostname()).digest('hex'));
  });
});

describe('resolveSessionEnvFields — failure isolation', () => {
  it('never throws: a getMCPConfigSummary rejection degrades every field to its empty default', async () => {
    getMCPConfigSummaryMock.mockRejectedValue(new Error('boom'));

    const fields = await resolveSessionEnvFields(CWD, 'claude-sonnet-5', 'auto');

    expect(fields).toEqual({
      provider: '',
      api_host: '',
      configured_model: 'claude-sonnet-5',
      effort: '',
      permission_mode: 'auto',
      output_style: '',
      plugins: {},
      mcp_servers: [],
      os: '',
      arch: '',
      node_version: '',
      timezone: '',
      hostname_hash: '',
    });
  });

  it('degrades hostname_hash to empty rather than an unsalted hash when the installation id is unavailable', async () => {
    getInstallationIdMock.mockRejectedValue(new Error('no home dir'));

    const fields = await resolveSessionEnvFields(CWD, 'm', 'auto');

    expect(fields.hostname_hash).toBe('');
  });
});

describe('sessionEnvFieldsEqual', () => {
  const base = {
    provider: 'anthropic',
    api_host: 'api.anthropic.com',
    configured_model: 'claude-sonnet-5',
    effort: 'high',
    permission_mode: 'auto',
    output_style: '',
    plugins: { 'a@one': '1', 'b@two': '2' },
    mcp_servers: ['a', 'b'],
    os: 'linux',
    arch: 'x64',
    node_version: 'v20.0.0',
    timezone: 'UTC',
    hostname_hash: 'deadbeef',
  };

  it('compares field-by-field, ignoring plugin key order', () => {
    expect(sessionEnvFieldsEqual(base, { ...base, plugins: { 'b@two': '2', 'a@one': '1' } })).toBe(true);
  });

  it('detects a changed scalar, a changed plugin set and reordered mcp_servers', () => {
    expect(sessionEnvFieldsEqual(base, { ...base, effort: 'low' })).toBe(false);
    expect(sessionEnvFieldsEqual(base, { ...base, plugins: { 'a@one': '1' } })).toBe(false);
    expect(sessionEnvFieldsEqual(base, { ...base, mcp_servers: ['b', 'a'] })).toBe(false);
  });
});
