import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveGitEmail: vi.fn(async () => 'git@example.com'),
  resolveCodemieCliEmail: vi.fn(async () => 'cli@example.com'),
  resolveOsUser: vi.fn(() => 'osuser'),
  resolveIdentity: vi.fn(async () => ({ developerName: 'Dev User', identitySource: 'jwt' })),
  resolveEmailFromCredentials: vi.fn(() => 'dev@example.com'),
}));

vi.mock('@/agents/core/identity-resolver.js', () => mocks);
vi.mock('@/agents/core/hook-credentials.js', () => ({ resolveHookCredentials: vi.fn(async () => null) }));
vi.mock('@/utils/cli-updater.js', () => ({ getCurrentCliVersion: vi.fn(async () => '1.2.3') }));
vi.mock('@/utils/config.js', () => ({
  ConfigLoader: {
    getActiveProfileName: vi.fn(async () => null),
    load: vi.fn(async () => ({})),
    hasLocalConfig: vi.fn(async () => false),
  },
}));
vi.mock('@/agents/core/session-project-pin.js', () => ({
  readPinnedProjectName: vi.fn(async () => undefined),
  pinProjectName: vi.fn(async (_sessionId: string, projectName: string) => projectName),
}));
vi.mock('@/utils/logger.js', () => ({ logger: { debug: vi.fn() } }));

const { resolveIdentityFields, resolveIdentityCandidateFields } = await import('../identity-fields.js');

describe('identity-fields', () => {
  const originalProject = process.env.CODEMIE_PROJECT;

  beforeEach(() => {
    process.env.CODEMIE_PROJECT = 'my-project';
  });

  afterEach(() => {
    if (originalProject === undefined) {
      delete process.env.CODEMIE_PROJECT;
    } else {
      process.env.CODEMIE_PROJECT = originalProject;
    }
  });

  it('merges the ranked identity with CODEMIE_PROJECT and the CLI version', async () => {
    await expect(resolveIdentityFields({ cwd: '/repo', sessionId: 's' })).resolves.toEqual({
      user_email: 'dev@example.com',
      developer_name: 'Dev User',
      identity_source: 'jwt',
      codemie_project_name: 'my-project',
      codemie_cli_version: '1.2.3',
    });
  });

  it('returns each raw identity candidate independently', async () => {
    await expect(resolveIdentityCandidateFields({ cwd: '/repo' })).resolves.toEqual({
      git_email: 'git@example.com',
      codemie_cli_email: 'cli@example.com',
      os_user: 'osuser',
    });
  });

  it('never throws: an identity-tier failure degrades the identity fields only', async () => {
    mocks.resolveIdentity.mockRejectedValueOnce(new Error('boom'));

    const fields = await resolveIdentityFields({ cwd: '/repo', sessionId: 's' });

    expect(fields).toEqual({
      user_email: '',
      developer_name: '',
      identity_source: '',
      codemie_project_name: 'my-project',
      codemie_cli_version: '1.2.3',
    });
  });
});
