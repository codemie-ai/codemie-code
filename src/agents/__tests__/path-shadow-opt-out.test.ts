/**
 * Guards which agent plugins opt out of the PATH shadow check (EPMCDME-16969).
 * Plugins spreading another plugin's metadata inherit its opt-out, so a new
 * entry here must be a deliberate decision.
 */

import { describe, it, expect } from 'vitest';
import { ClaudePluginMetadata } from '../plugins/claude/claude.plugin.js';
import { ClaudeAcpPluginMetadata } from '../plugins/claude/claude-acp.plugin.js';
import { KimiPluginMetadata } from '../plugins/kimi/kimi.plugin.js';
import { KimiAcpPluginMetadata } from '../plugins/kimi/kimi-acp.plugin.js';
import { CodeMieCodePluginMetadata } from '../plugins/codemie-code.plugin.js';
import type { AgentMetadata } from '../core/types.js';

describe('pathShadowCheck opt-outs', () => {
  const all: AgentMetadata[] = [
    ClaudePluginMetadata,
    ClaudeAcpPluginMetadata,
    KimiPluginMetadata,
    KimiAcpPluginMetadata,
    CodeMieCodePluginMetadata,
  ];

  it('lists exactly the plugins that opt out', () => {
    const optedOut = all.filter((m) => m.pathShadowCheck === false).map((m) => m.name).sort();
    expect(optedOut).toEqual(['claude', 'codemie-code', 'kimi', 'kimi-acp']);
  });

  it('keeps the npm-installed claude-acp checked', () => {
    expect(ClaudeAcpPluginMetadata.pathShadowCheck).toBeUndefined();
  });
});
