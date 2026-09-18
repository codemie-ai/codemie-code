/**
 * Gemini model validation (EPMCDME-14421 fix).
 *
 * Pins the pure validation logic and the best-effort validateGeminiModel flow
 * (catalog fetch mocked — no network). This is what turns an invalid gemini
 * model from an opaque upstream HTTP 400 into a clear, actionable error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

// Mock the catalog fetch so validateGeminiModel never hits the network.
// Matches the repo's proven pattern (see copilot-cli.models.test.ts): spread the
// original module and replace only fetchCodeMieLlmModels with the vi.fn directly.
const fetchMock = vi.hoisted(() => vi.fn<() => Promise<LlmModel[]>>());
vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>();
  return { ...actual, fetchCodeMieLlmModels: fetchMock };
});

import {
  isGeminiCompatibleModelName,
  getGeminiModelIds,
  assertGeminiModelAllowed,
  validateGeminiModel,
} from '../gemini.models.js';

/** Minimal LlmModel factory (only the fields the reader touches). */
function model(fields: Partial<LlmModel>): LlmModel {
  return { enabled: true, ...fields } as unknown as LlmModel;
}

describe('isGeminiCompatibleModelName', () => {
  it('accepts gemini-* names', () => {
    expect(isGeminiCompatibleModelName('gemini-3.1-pro')).toBe(true);
    expect(isGeminiCompatibleModelName('gemini-3-flash')).toBe(true);
    expect(isGeminiCompatibleModelName('Gemini 3.1 Pro')).toBe(true);
  });
  it('rejects other providers and empty', () => {
    expect(isGeminiCompatibleModelName('claude-sonnet-4-6')).toBe(false);
    expect(isGeminiCompatibleModelName('gpt-5')).toBe(false);
    expect(isGeminiCompatibleModelName('kimi-k2')).toBe(false);
    expect(isGeminiCompatibleModelName(undefined)).toBe(false);
    expect(isGeminiCompatibleModelName('')).toBe(false);
  });
});

describe('getGeminiModelIds', () => {
  it('keeps enabled gemini deployments, drops others, dedups, prefers deployment_name', () => {
    const ids = getGeminiModelIds([
      model({ deployment_name: 'gemini-3.1-pro', base_name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }),
      model({ deployment_name: 'claude-sonnet-4-6', base_name: 'claude-sonnet-4-6', label: 'Claude' }),
      model({ deployment_name: 'gemini-3-flash', base_name: 'gemini-3-flash', label: 'Gemini 3 Flash' }),
      model({ enabled: false, deployment_name: 'gemini-3-disabled', base_name: 'gemini-3-disabled', label: 'x' }),
      model({ deployment_name: 'gemini-3.1-pro', base_name: 'gemini-3.1-pro', label: 'dup' }), // dup
      model({ deployment_name: 'gpt-5', base_name: 'gpt-5', label: 'GPT-5' }),
    ]);
    expect(ids).toEqual(['gemini-3.1-pro', 'gemini-3-flash']);
  });

  it('falls back to a whitespace-free candidate over a spaced label', () => {
    const ids = getGeminiModelIds([
      model({ deployment_name: undefined as unknown as string, base_name: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }),
    ]);
    expect(ids).toEqual(['gemini-3.6-flash']);
  });
});

describe('assertGeminiModelAllowed', () => {
  const avail = ['gemini-3.1-pro', 'gemini-3-flash'];

  it('accepts a valid, available gemini model', () => {
    expect(() => assertGeminiModelAllowed('gemini-3.1-pro', avail)).not.toThrow();
  });
  it('rejects a gemini name that is not in the catalog, listing what is', () => {
    expect(() => assertGeminiModelAllowed('gemini-3-pro', avail)).toThrow(/not available/i);
    expect(() => assertGeminiModelAllowed('gemini-3-pro', avail)).toThrow(/gemini-3\.1-pro/);
  });
  it('rejects a non-gemini model as not a gemini model', () => {
    expect(() => assertGeminiModelAllowed('gpt-5', avail)).toThrow(/not a Gemini model/i);
    expect(() => assertGeminiModelAllowed(undefined, avail)).toThrow(/not a Gemini model/i);
  });
  it('skips the availability check when the list is empty (cannot adjudicate)', () => {
    expect(() => assertGeminiModelAllowed('gemini-3.1-pro', [])).not.toThrow();
  });
});

describe('validateGeminiModel (best-effort, fetch mocked)', () => {
  const baseEnv = { CODEMIE_JWT_TOKEN: 'tok', CODEMIE_BASE_URL: 'https://x/code-assistant-api' };
  const catalog = [
    model({ deployment_name: 'gemini-3.1-pro', base_name: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' }),
    model({ deployment_name: 'gemini-3-flash', base_name: 'gemini-3-flash', label: 'Gemini 3 Flash' }),
  ];

  beforeEach(() => fetchMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('passes for a model that is in the catalog', async () => {
    fetchMock.mockResolvedValue(catalog);
    await expect(validateGeminiModel({ ...baseEnv, CODEMIE_MODEL: 'gemini-3.1-pro' })).resolves.toBeUndefined();
  });

  it('throws a clear error for a model that is NOT in the catalog', async () => {
    fetchMock.mockResolvedValue(catalog);
    await expect(validateGeminiModel({ ...baseEnv, CODEMIE_MODEL: 'gemini-3-pro' }))
      .rejects.toThrow(/not available in CodeMie for codemie-gemini/i);
  });

  it('does nothing when no model is configured', async () => {
    await expect(validateGeminiModel({ ...baseEnv })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is best-effort: a fetch failure does NOT block the run', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(validateGeminiModel({ ...baseEnv, CODEMIE_MODEL: 'gemini-3-pro' })).resolves.toBeUndefined();
  });

  it('skips validation when the catalog exposes no gemini models', async () => {
    fetchMock.mockResolvedValue([model({ deployment_name: 'gpt-5', base_name: 'gpt-5', label: 'GPT-5' })]);
    await expect(validateGeminiModel({ ...baseEnv, CODEMIE_MODEL: 'gemini-3-pro' })).resolves.toBeUndefined();
  });
});
