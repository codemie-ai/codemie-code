/**
 * Tests for REASONING_SANITIZER_PLUGIN_SOURCE string constant.
 *
 * Pure string validation — no mocks needed.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { REASONING_SANITIZER_PLUGIN_SOURCE } from '../reasoning-sanitizer-source.js';

describe('REASONING_SANITIZER_PLUGIN_SOURCE', () => {
  it('is a non-empty string', () => {
    expect(typeof REASONING_SANITIZER_PLUGIN_SOURCE).toBe('string');
    expect(REASONING_SANITIZER_PLUGIN_SOURCE.length).toBeGreaterThan(0);
  });

  it('contains OpenCode Plugin type import and default export', () => {
    expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('import type { Plugin } from "@opencode-ai/plugin"');
    expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('export default');
  });

  it('contains chat.params hook', () => {
    expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('"chat.params"');
  });

  describe('param deletion', () => {
    it('deletes reasoningSummary', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('delete output.options.reasoningSummary');
    });

    it('deletes reasoning_summary', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('delete output.options.reasoning_summary');
    });

    it('deletes reasoning', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('delete output.options.reasoning');
    });

    it('does NOT delete reasoningEffort', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).not.toContain('delete output.options.reasoningEffort');
    });

    it('does NOT delete reasoning_effort', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).not.toContain('delete output.options.reasoning_effort');
    });
  });

  describe('provider detection', () => {
    it('detects litellm provider', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('"litellm"');
    });

    it('detects codemie-proxy provider', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('"codemie-proxy"');
    });

    it('checks providerID', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('input.model.providerID');
    });

    it('checks api.id', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('input.model.api.id');
    });

    it('uses case-insensitive comparison', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('.toLowerCase()');
    });

    it('checks litellmProxy option', () => {
      expect(REASONING_SANITIZER_PLUGIN_SOURCE).toContain('litellmProxy');
    });
  });
});
