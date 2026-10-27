// src/cli/commands/proxy/connectors/__tests__/copilot-cli-otlp.test.ts

import { describe, it, expect } from 'vitest';
import { CLI_HOOK_EVENT_NAMES } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { CLI_HOOK_TIMEOUT_SECONDS, buildHookFileContent } from '../copilot-cli-otlp.js';

describe('buildHookFileContent', () => {
  const file = buildHookFileContent() as { version: unknown; hooks: Record<string, unknown[]> };

  it('declares the literal config version Copilot CLI requires', () => {
    expect(file.version).toBe(1);
  });

  it('nests every event under a top-level hooks object', () => {
    expect(Object.keys(file).sort()).toEqual(['hooks', 'version']);
    expect(Object.keys(file.hooks)).toEqual([...CLI_HOOK_EVENT_NAMES]);
  });

  it('wires each event to one exec entry that passes its own --event name', () => {
    for (const eventName of CLI_HOOK_EVENT_NAMES) {
      const entries = file.hooks[eventName] as Array<{ exec: string; args: string[]; timeoutSec: number }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].exec).toBe(process.execPath);
      expect(entries[0].args.slice(1)).toEqual(['hook', '--agent', 'copilot-cli-otlp', '--event', eventName]);
      expect(entries[0].timeoutSec).toBe(CLI_HOOK_TIMEOUT_SECONDS);
    }
  });
});
