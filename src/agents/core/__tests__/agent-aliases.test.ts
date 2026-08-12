import { describe, it, expect } from 'vitest';
import {
  getAgentInstallCommand,
  getAgentLauncherCommand,
  getAgentUninstallCommand,
  getUserFacingAgentName,
  resolveAgentAlias,
} from '../agent-aliases.js';

describe('agent aliases', () => {
  it('maps the user-facing copilot command to the internal copilot-cli agent', () => {
    expect(resolveAgentAlias('copilot')).toBe('copilot-cli');
    expect(resolveAgentAlias('copilot-cli')).toBe('copilot-cli');
  });

  it('keeps copilot-cli internal while rendering Copilot user-facing commands', () => {
    expect(getUserFacingAgentName('copilot-cli')).toBe('copilot');
    expect(getAgentInstallCommand('copilot-cli')).toBe('codemie install copilot');
    expect(getAgentUninstallCommand('copilot-cli')).toBe('codemie uninstall copilot');
    expect(getAgentLauncherCommand('copilot-cli')).toBe('codemie-copilot');
  });

  it('leaves unrelated agents on the generic launcher convention', () => {
    expect(resolveAgentAlias('codex')).toBe('codex');
    expect(getUserFacingAgentName('codex')).toBe('codex');
    expect(getAgentLauncherCommand('codex')).toBe('codemie-codex');
  });
});
