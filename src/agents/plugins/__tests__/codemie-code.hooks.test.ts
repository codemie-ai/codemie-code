/**
 * codemie-code default (inline) hooks are localized to an absolute codemie path
 * before being serialized to OPENCODE_HOOKS. Covers EPMCDME-14035 (Bug 1).
 * @group unit
 */
import { describe, it, expect } from 'vitest';
import { buildDefaultHooks } from '../codemie-code.plugin.js';

describe('codemie-code default hooks', () => {
  it('uses the resolved absolute codemie path for default hook commands', () => {
    const hooks = buildDefaultHooks('/abs/codemie') as Record<
      string,
      { hooks: { command: string }[] }[]
    >;
    expect(hooks.SessionStart[0].hooks[0].command).toBe('/abs/codemie hook');
    expect(hooks.SessionEnd[0].hooks[0].command).toBe('/abs/codemie hook');
  });

  it('preserves timeouts on default hook commands', () => {
    const hooks = buildDefaultHooks('/abs/codemie') as Record<
      string,
      { hooks: { command: string; timeout: number }[] }[]
    >;
    expect(hooks.SessionStart[0].hooks[0].timeout).toBe(5);
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
  });
});
