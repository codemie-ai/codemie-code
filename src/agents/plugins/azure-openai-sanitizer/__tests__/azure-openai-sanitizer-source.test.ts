/**
 * Tests for AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE string constant.
 *
 * Pure string validation — no mocks needed.
 *
 * @group unit
 */

import { describe, it, expect } from 'vitest';
import { AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE } from '../azure-openai-sanitizer-source.js';

describe('AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE', () => {
  it('is a non-empty string', () => {
    expect(typeof AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toBe('string');
    expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE.length).toBeGreaterThan(0);
  });

  it('contains OpenCode Plugin type import and default export', () => {
    expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('import type { Plugin } from "@opencode-ai/plugin"');
    expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('export default');
  });

  it('contains chat.params hook', () => {
    expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"chat.params"');
  });

  describe('provider detection', () => {
    it('detects azure-openai- provider by prefix', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('azure-openai-');
    });

    it('checks providerID', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('providerID');
    });

    it('uses case-insensitive comparison', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('.toLowerCase()');
    });
  });

  describe('cache_control stripping', () => {
    it('strips cache_control from message content', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('cache_control');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('sanitizeMessage');
    });
  
    it('strips cache_control from top-level message field', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('delete m["cache_control"]');
    });
  
    it('strips cache_control from content[] items inside message', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('delete cleaned["cache_control"]');
    });
  
    it('handles array content (multipart messages)', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('Array.isArray');
    });
  
    it('strips cache_control for ALL models including Claude', () => {
      // No isClaude guard — always strip for azure-openai-* providers
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).not.toContain('isClaude');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).not.toContain('isClaudeModel');
    });
  
    it('applies sanitizeMessage to all messages', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('output.messages.map(sanitizeMessage)');
    });

    it('strips reasoning_content from messages and nested parts', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('reasoning_content');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('delete m["reasoning_content"]');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('delete cleaned["reasoning_content"]');
    });
  });

  describe('thinking stripping', () => {
    it('strips thinking param', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"thinking"');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('sanitizeParamsContainer');
    });
  });

  describe('reasoning param stripping', () => {
    it('strips reasoningSummary', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"reasoningSummary"');
    });

    it('strips reasoning_summary', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"reasoning_summary"');
    });

    it('strips reasoning', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"reasoning"');
    });

    it('strips broader top-level compatibility fields', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"parallel_tool_calls"');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"store"');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"metadata"');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('"prediction"');
    });

    it('normalizes messages to allowed OpenAI fields', () => {
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('ALLOWED_MESSAGE_FIELDS');
      expect(AZURE_OPENAI_SANITIZER_PLUGIN_SOURCE).toContain('ALLOWED_TOOL_CALL_FIELDS');
    });
  });
});
