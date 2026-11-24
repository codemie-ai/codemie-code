import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { SSO_LOGIN_WAIT_MS } from '@/providers/plugins/sso/sso.detached-login.js';

// The prompt hook may hold the prompt for SSO_LOGIN_WAIT_MS; the host must not kill it first.
const HEADROOM_MS = 15_000;

interface HookEntry { command?: string; timeout?: number; statusMessage?: string }
interface Settings { hooks: Record<string, Array<{ hooks: HookEntry[] }>> }

function codemieHook(relativePath: string, event: string): HookEntry {
  const settings = JSON.parse(readFileSync(join(process.cwd(), relativePath), 'utf-8')) as Settings;
  const hook = settings.hooks[event].flatMap((g) => g.hooks).find((h) => h.command === 'codemie hook');
  if (!hook) throw new Error(`no codemie hook for ${event} in ${relativePath}`);
  return hook;
}

describe('bundled prompt-hook timeouts', () => {
  it('Claude UserPromptSubmit timeout (seconds) outlasts the SSO sign-in wait', () => {
    const hook = codemieHook('src/agents/plugins/claude/plugin/hooks/hooks.json', 'UserPromptSubmit');
    expect((hook.timeout ?? 0) * 1000).toBeGreaterThanOrEqual(SSO_LOGIN_WAIT_MS + HEADROOM_MS);
    expect(hook.statusMessage).toContain('continue automatically');
  });

  it('Gemini BeforeAgent timeout (ms) outlasts the SSO sign-in wait', () => {
    const hook = codemieHook('src/agents/plugins/gemini/extension/hooks/hooks.json', 'BeforeAgent');
    expect(hook.timeout ?? 0).toBeGreaterThanOrEqual(SSO_LOGIN_WAIT_MS + HEADROOM_MS);
  });
});
