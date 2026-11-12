/**
 * Analytics connector table tests
 * @group unit
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../connectors/claude-code-otlp.js', () => ({
  hasClaudeCodeOtlpHooks: vi.fn(),
}));

vi.mock('../connectors/desktop.js', () => ({
  readDesktopGateway: vi.fn(),
}));

vi.mock('@/agents/core/copilot-connector-scope.js', () => ({
  readCopilotConnectorScope: vi.fn(),
}));

vi.mock('../analytics-status.js', () => ({
  collectClaudeAnalyticsStatus: vi.fn(),
  collectCopilotAnalyticsStatus: vi.fn(),
  formatClaudeAnalyticsStatus: vi.fn(),
  formatCopilotAnalyticsStatus: vi.fn(),
}));

import { hasClaudeCodeOtlpHooks } from '../connectors/claude-code-otlp.js';
import { readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { readDesktopGateway } from '../connectors/desktop.js';
import {
  collectClaudeAnalyticsStatus,
  collectCopilotAnalyticsStatus,
  formatClaudeAnalyticsStatus,
  formatCopilotAnalyticsStatus,
  type ClaudeAnalyticsStatus,
  type CopilotAnalyticsStatus,
} from '../analytics-status.js';
import { ANALYTICS_CONNECTORS, hasActiveAnalyticsConnector } from '../analytics-connectors.js';

function connector(id: string) {
  const found = ANALYTICS_CONNECTORS.find((c) => c.id === id);
  if (!found) throw new Error(`no connector ${id}`);
  return found;
}

describe('ANALYTICS_CONNECTORS', () => {
  beforeEach(() => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockReset().mockResolvedValue(false);
    vi.mocked(readCopilotConnectorScope).mockReset().mockResolvedValue({ kind: 'ok', value: { enabled: false } });
  });

  it('lists Claude Code, Copilot CLI and Copilot Chat', () => {
    expect(ANALYTICS_CONNECTORS.map((c) => c.id)).toEqual([
      'claude-code-otlp',
      'copilot-cli-otlp',
      'copilot-chat-otlp',
    ]);
  });

  it('treats Claude Code as active when its hooks are installed', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockResolvedValue(true);
    await expect(connector('claude-code-otlp').isActive()).resolves.toBe(true);
  });

  it.each(['copilot-cli-otlp', 'copilot-chat-otlp'])('treats %s as active when its scope is enabled', async (id) => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    await expect(connector(id).isActive()).resolves.toBe(true);
    expect(readCopilotConnectorScope).toHaveBeenCalledWith(id);
  });

  it.each(['copilot-cli-otlp', 'copilot-chat-otlp'])('treats %s as inactive when disabled or corrupt', async (id) => {
    await expect(connector(id).isActive()).resolves.toBe(false);
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'corrupt' });
    await expect(connector(id).isActive()).resolves.toBe(false);
  });

  it('delegates collect and format to the Claude status helpers', async () => {
    const status = { hooksInstalled: true } as ClaudeAnalyticsStatus;
    vi.mocked(collectClaudeAnalyticsStatus).mockResolvedValue(status);
    vi.mocked(formatClaudeAnalyticsStatus).mockReturnValue('claude text');
    const entry = connector('claude-code-otlp');

    const collected = await entry.collect('/work');

    expect(collectClaudeAnalyticsStatus).toHaveBeenCalledWith('/work');
    expect(entry.format(collected)).toBe('claude text');
    expect(formatClaudeAnalyticsStatus).toHaveBeenCalledWith(status);
  });

  it('delegates collect and format to the Copilot status helpers with the connector id', async () => {
    const status = { connector: 'copilot-chat-otlp' } as CopilotAnalyticsStatus;
    vi.mocked(collectCopilotAnalyticsStatus).mockResolvedValue(status);
    vi.mocked(formatCopilotAnalyticsStatus).mockReturnValue('copilot text');
    const entry = connector('copilot-chat-otlp');

    const collected = await entry.collect('/work');

    expect(collectCopilotAnalyticsStatus).toHaveBeenCalledWith('copilot-chat-otlp', '/work');
    expect(entry.format(collected)).toBe('copilot text');
    expect(formatCopilotAnalyticsStatus).toHaveBeenCalledWith(status);
  });
});

describe('hasActiveAnalyticsConnector', () => {
  beforeEach(() => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockReset().mockResolvedValue(false);
    vi.mocked(readCopilotConnectorScope).mockReset().mockResolvedValue({ kind: 'ok', value: { enabled: false } });
    vi.mocked(readDesktopGateway).mockReset().mockResolvedValue(null);
  });

  it('is true when only Claude Desktop is connected to a local gateway', async () => {
    vi.mocked(readDesktopGateway).mockResolvedValue({ port: 4001 });
    await expect(hasActiveAnalyticsConnector()).resolves.toBe(true);
  });

  it('is false when no connector is connected', async () => {
    await expect(hasActiveAnalyticsConnector()).resolves.toBe(false);
  });

  it('is true when any connector is connected', async () => {
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    await expect(hasActiveAnalyticsConnector()).resolves.toBe(true);
  });

  it('counts a connector whose check throws as inactive without throwing', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockRejectedValue(new Error('settings.json unreadable'));
    vi.mocked(readCopilotConnectorScope).mockRejectedValue(new Error('boom'));
    await expect(hasActiveAnalyticsConnector()).resolves.toBe(false);
  });

  it('still reports an active connector when another check throws', async () => {
    vi.mocked(hasClaudeCodeOtlpHooks).mockRejectedValue(new Error('settings.json unreadable'));
    vi.mocked(readCopilotConnectorScope).mockResolvedValue({ kind: 'ok', value: { enabled: true, scope: 'user' } });
    await expect(hasActiveAnalyticsConnector()).resolves.toBe(true);
  });
});
