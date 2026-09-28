/**
 * Model name normalization unit tests.
 */

import { describe, it, expect } from 'vitest';
import { normalizeModelName } from '../model-normalizer.js';

describe('normalizeModelName', () => {
  it('passes through standard model names unchanged', () => {
    expect(normalizeModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5-20250929');
    expect(normalizeModelName('gpt-4-turbo')).toBe('gpt-4-turbo');
    expect(normalizeModelName('gemini-1.5-pro')).toBe('gemini-1.5-pro');
  });

  it('extracts the model from Bedrock converse format', () => {
    expect(normalizeModelName('converse/global.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('extracts the model from Bedrock direct format', () => {
    expect(normalizeModelName('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('extracts the model from the combined bedrock/converse/ prefix', () => {
    expect(normalizeModelName('bedrock/converse/us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('strips the Kimi Code vendor prefix', () => {
    expect(normalizeModelName('kimi-code/kimi-for-coding')).toBe('kimi-for-coding');
    expect(normalizeModelName('kimi-code/kimi-k2')).toBe('kimi-k2');
    expect(normalizeModelName('kimi-code/kimi-k2-5')).toBe('kimi-k2-5');
  });

  it('strips the openai. vendor prefix', () => {
    expect(normalizeModelName('openai.gpt-4o')).toBe('gpt-4o');
  });

  it('strips the openai/ vendor prefix', () => {
    expect(normalizeModelName('openai/gpt-4o')).toBe('gpt-4o');
  });

  it('strips the azure/ vendor prefix', () => {
    expect(normalizeModelName('azure/gpt-4o')).toBe('gpt-4o');
  });

  it('strips the vertex_ai/ vendor prefix', () => {
    expect(normalizeModelName('vertex_ai/gemini-3-pro')).toBe('gemini-3-pro');
  });

  it('strips the anthropic/ vendor prefix', () => {
    expect(normalizeModelName('anthropic/claude-opus-5')).toBe('claude-opus-5');
  });

  it('strips the moonshotai. vendor prefix', () => {
    expect(normalizeModelName('moonshotai.kimi-k2.5')).toBe('kimi-k2.5');
  });

  it('strips the qwen. vendor prefix', () => {
    expect(normalizeModelName('qwen.qwen3-coder-480b-a35b-v1')).toBe('qwen3-coder-480b-a35b-v1');
  });
});
