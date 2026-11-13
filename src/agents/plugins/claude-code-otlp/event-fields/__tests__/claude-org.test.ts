import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { debugMock, homeRef } = vi.hoisted(() => ({ debugMock: vi.fn(), homeRef: { dir: '' } }));

vi.mock('@/utils/logger.js', () => ({ logger: { debug: debugMock, info: debugMock, warn: debugMock, error: debugMock } }));
vi.mock('@/utils/paths.js', () => ({ resolveHomeDir: (p = '') => join(homeRef.dir, p) }));
vi.mock('@/utils/mcp-config.js', () => ({ getMCPConfigSummary: vi.fn() }));
vi.mock('@/utils/config.js', () => ({ getInstallationId: vi.fn() }));
vi.mock('@/agents/core/event-fields/env-fields.js', () => ({ resolveEnvFields: vi.fn() }));
vi.mock('@/agents/plugins/claude/claude.plugin.js', () => ({ ClaudePluginMetadata: {} }));

const { readClaudeOrganization } = await import('../claude-org.js');

const acct = (organizationName: unknown) => JSON.stringify({ oauthAccount: { organizationName } });

describe('readClaudeOrganization', () => {
  let home: string;
  let cfg: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'org-home-'));
    cfg = mkdtempSync(join(tmpdir(), 'org-cfg-'));
    homeRef.dir = home;
    debugMock.mockClear();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  });

  it('returns trimmed value from home when CLAUDE_CONFIG_DIR unset', async () => {
    writeFileSync(join(home, '.claude.json'), acct('  Fake Org  '));
    expect(await readClaudeOrganization({})).toBe('Fake Org');
  });

  it('reads only CLAUDE_CONFIG_DIR/.claude.json when set (no home fallback)', async () => {
    writeFileSync(join(home, '.claude.json'), acct('Home Org'));
    expect(await readClaudeOrganization({ CLAUDE_CONFIG_DIR: cfg })).toBeUndefined();
    writeFileSync(join(cfg, '.claude.json'), acct('Cfg Org'));
    expect(await readClaudeOrganization({ CLAUDE_CONFIG_DIR: cfg })).toBe('Cfg Org');
  });

  it('returns undefined for missing/unreadable file', async () => {
    expect(await readClaudeOrganization({})).toBeUndefined();
    writeFileSync(join(home, '.claude.json'), '{not json');
    expect(await readClaudeOrganization({})).toBeUndefined();
  });

  it.each([[42], [null], [['x']], [{}], ['   '], ['a'.repeat(257)]])('returns undefined for invalid value %j', async (v) => {
    writeFileSync(join(home, '.claude.json'), acct(v));
    expect(await readClaudeOrganization({})).toBeUndefined();
  });

  it('accepts exactly 256 chars', async () => {
    writeFileSync(join(home, '.claude.json'), acct('a'.repeat(256)));
    expect(await readClaudeOrganization({})).toBe('a'.repeat(256));
  });

  it('never logs the value', async () => {
    writeFileSync(join(home, '.claude.json'), acct('Secret Org Name'));
    await readClaudeOrganization({});
    expect(JSON.stringify(debugMock.mock.calls)).not.toContain('Secret Org Name');
  });
});
