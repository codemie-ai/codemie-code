import { describe, it, expect } from 'vitest';
import { ClaudePluginMetadata } from '../claude/claude.plugin.js';
import { CodexPluginMetadata } from '../codex/codex.plugin.js';
import { OpenCodePluginMetadata } from '../opencode/opencode.plugin.js';
import { ClaudeAcpPluginMetadata } from '../claude/claude-acp.plugin.js';

describe('sessionAnalyticsReport opt-in metadata', () => {
  it('is enabled by default for claude, codex, opencode', () => {
    expect(ClaudePluginMetadata.sessionAnalyticsReport).toBe(true);
    expect(CodexPluginMetadata.sessionAnalyticsReport).toBe(true);
    expect(OpenCodePluginMetadata.sessionAnalyticsReport).toBe(true);
  });

  it('is inherited by claude-acp via metadata spread', () => {
    expect(ClaudeAcpPluginMetadata.sessionAnalyticsReport).toBe(true);
  });
});
