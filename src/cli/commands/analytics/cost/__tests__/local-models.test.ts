import { describe, it, expect } from 'vitest';
import { isLocalModel, isOllamaCloudTag } from '../local-models.js';

describe('isOllamaCloudTag', () => {
  it.each(['gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'deepseek-v3.1:cloud', 'GPT-OSS:120B-CLOUD'])('treats %s as a cloud tag', (m) => {
    expect(isOllamaCloudTag(m)).toBe(true);
  });

  it.each(['gpt-oss:120b', 'qwen3.8:27b', 'llama3', 'cloudy:7b'])('treats %s as a local tag', (m) => {
    expect(isOllamaCloudTag(m)).toBe(false);
  });
});

describe('isLocalModel', () => {
  it('is true for a non-cloud model served by the ollama provider', () => {
    expect(isLocalModel('ollama', 'gpt-oss:120b')).toBe(true);
    expect(isLocalModel('Ollama', 'qwen3.8:27b')).toBe(true);
  });

  it('is false for an Ollama cloud tag', () => {
    expect(isLocalModel('ollama', 'gpt-oss:120b-cloud')).toBe(false);
  });

  it('is false for any other or missing provider', () => {
    expect(isLocalModel('litellm', 'gpt-oss:120b')).toBe(false);
    expect(isLocalModel(undefined, 'gpt-oss:120b')).toBe(false);
  });
});
