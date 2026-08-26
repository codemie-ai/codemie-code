/**
 * Cost rates in the model list handed to Pi.
 *
 * Pi accepts the `cost` block as optional but every rate inside it as mandatory, and it rejects
 * the whole `models.json` — every CodeMie model, not just the offending entry — when a rate is
 * missing or not a number. Several of these tests exist for that reason alone: one pins the exact
 * key set, the rest pin that no hostile value from the HTTP payload reaches the emitted entry.
 * Whether the serialized file itself loads is proven by the end-to-end harness, not here.
 *
 * The unit conversion is the other half. CodeMie reports USD per token, Pi divides its rates by
 * 1,000,000, so a rate passed through unconverted is not a rounding error — it is a cost report
 * a million times too small, which is indistinguishable from the zero-cost bug this fixes.
 *
 * `lookupPrice` is mocked rather than exercised: the vendored table is refreshed from an upstream
 * source, and tests that assert its current numbers would fail on a data refresh that broke
 * nothing.
 *
 * @group unit
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

vi.mock('../../../../utils/pricing.js', () => ({
  lookupPrice: vi.fn(),
}));

import { lookupPrice } from '../../../../utils/pricing.js';
import { convertLlmModelToPiEntry } from '../pi.models.js';

/** What `lookupPrice` returns for a Claude model: already USD per million, with a 1h write rate Pi has no field for. */
const VENDORED_CLAUDE = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheCreation: 3.75,
  cacheWrite1h: 6,
};

function llmModel(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    base_name: 'gpt-4.1',
    deployment_name: 'gpt-4.1',
    label: 'GPT-4.1',
    enabled: true,
    ...overrides,
  };
}

describe('convertLlmModelToPiEntry — cost', () => {
  beforeEach(() => {
    vi.mocked(lookupPrice).mockReset();
    vi.mocked(lookupPrice).mockReturnValue(null);
  });

  describe('API-provided rates', () => {
    it('should convert every rate from USD per token to USD per million', () => {
      const entry = convertLlmModelToPiEntry(
        llmModel({
          cost: {
            input: 0.000002,
            output: 0.000008,
            cache_read_input_token_cost: 0.0000005,
            cache_creation_input_token_cost: 0.0000025,
          },
        }),
      );

      expect(entry.cost?.input).toBeCloseTo(2, 6);
      expect(entry.cost?.output).toBeCloseTo(8, 6);
      expect(entry.cost?.cacheRead).toBeCloseTo(0.5, 6);
      expect(entry.cost?.cacheWrite).toBeCloseTo(2.5, 6);
    });

    it('should win over the vendored table', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(
        llmModel({ cost: { input: 0.000009, output: 0.000009 } }),
      );

      expect(entry.cost?.input).toBeCloseTo(9, 6);
      expect(entry.cost?.output).toBeCloseTo(9, 6);
    });
  });

  describe('per-field fallback', () => {
    it('should take cache rates from the vendored table when the API sends only input and output', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(
        llmModel({ cost: { input: 0.000002, output: 0.000008 } }),
      );

      expect(entry.cost?.input).toBeCloseTo(2, 6);
      expect(entry.cost?.output).toBeCloseTo(8, 6);
      expect(entry.cost?.cacheRead).toBe(0.3);
      expect(entry.cost?.cacheWrite).toBe(3.75);
    });

    it('should price a model entirely from the vendored table when the API sends no cost at all', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(llmModel({ deployment_name: 'claude-sonnet-5' }));

      expect(lookupPrice).toHaveBeenCalledWith('claude-sonnet-5');
      expect(entry.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
    });
  });

  describe('shape Pi accepts', () => {
    it('should emit exactly the four rates Pi defines, dropping the 1h cache-write rate', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(llmModel({ deployment_name: 'claude-sonnet-5' }));

      expect(Object.keys(entry.cost ?? {}).sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    });

    it('should omit cost entirely when no source prices the model', () => {
      const entry = convertLlmModelToPiEntry(llmModel({ deployment_name: 'some-unpriced-model' }));

      expect(entry.cost).toBeUndefined();
      expect('cost' in entry).toBe(false);
    });

    it('should omit cost when the API reports every rate as zero and the table has no entry', () => {
      const entry = convertLlmModelToPiEntry(
        llmModel({ cost: { input: 0, output: 0, cache_read_input_token_cost: 0 } }),
      );

      expect(entry.cost).toBeUndefined();
    });
  });

  describe('malformed API payloads', () => {
    it('should fall back to the vendored table instead of emitting a non-number', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(
        llmModel({
          cost: {
            input: Number.NaN,
            output: Number.POSITIVE_INFINITY,
            cache_read_input_token_cost: -0.000001,
            cache_creation_input_token_cost: '0.000004' as unknown as number,
          },
        }),
      );

      expect(entry.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
      for (const rate of Object.values(entry.cost ?? {})) {
        expect(Number.isFinite(rate)).toBe(true);
      }
    });

    it('should fall back to zero when neither the payload nor the table yields a rate', () => {
      const entry = convertLlmModelToPiEntry(
        llmModel({ cost: { input: 0.000002, output: Number.NaN } }),
      );

      expect(entry.cost?.input).toBeCloseTo(2, 6);
      expect(entry.cost?.output).toBe(0);
    });

    /**
     * A rate large enough to overflow only once scaled: `1e308` is finite in the payload, so
     * screening the input accepts it, and `Infinity` serializes as `null` — which costs Pi the
     * entire file. The product has to be screened too.
     */
    it('should fall back when a finite rate overflows on conversion to per-million', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(llmModel({ cost: { input: 1e308, output: 0.000008 } }));

      expect(entry.cost?.input).toBe(3);
      expect(entry.cost?.output).toBeCloseTo(8, 6);
      expect(JSON.parse(JSON.stringify(entry)).cost.input).toBe(3);
    });

    it('should fall back to zero when an overflowing rate has no table entry either', () => {
      const entry = convertLlmModelToPiEntry(
        llmModel({ cost: { input: Number.MAX_VALUE, output: 0.000008 } }),
      );

      expect(entry.cost?.input).toBe(0);
      for (const rate of Object.values(entry.cost ?? {})) {
        expect(Number.isFinite(rate)).toBe(true);
      }
    });
  });

  describe('price table failures', () => {
    /**
     * The table is a vendored JSON asset read on first lookup, and this conversion runs inside the
     * plugin's unguarded `beforeRun`. A read failure must cost the user their cost report, never
     * their session.
     */
    it('should still produce an entry when the price table cannot be read', () => {
      vi.mocked(lookupPrice).mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory, open 'pricing.json'");
      });

      const entry = convertLlmModelToPiEntry(
        llmModel({ deployment_name: 'claude-sonnet-5', cost: { input: 0.000003 } }),
      );

      expect(entry.id).toBe('claude-sonnet-5');
      expect(entry.cost?.input).toBeCloseTo(3, 6);
      expect(entry.cost?.output).toBe(0);
    });

    it('should omit cost rather than throw when the table fails and the API priced nothing', () => {
      vi.mocked(lookupPrice).mockImplementation(() => {
        throw new Error('Unexpected token in JSON');
      });

      const entry = convertLlmModelToPiEntry(llmModel({ deployment_name: 'claude-sonnet-5' }));

      expect(entry.cost).toBeUndefined();
      expect(entry.id).toBe('claude-sonnet-5');
    });
  });

  describe('zero as an authoritative price', () => {
    /**
     * `0` from the API is a stated price, so it suppresses the table for that field while the
     * other fields still fall back — the per-field `??` semantics, pinned because the consequence
     * is easy to break by "fixing" zero into a gap.
     */
    it('should let an explicit zero suppress the table for that field only', () => {
      vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

      const entry = convertLlmModelToPiEntry(
        llmModel({ deployment_name: 'claude-sonnet-5', cost: { input: 0, output: 0 } }),
      );

      expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0.3, cacheWrite: 3.75 });
    });
  });

  it('should leave every other field of the entry untouched', () => {
    vi.mocked(lookupPrice).mockReturnValue(VENDORED_CLAUDE);

    const entry = convertLlmModelToPiEntry(
      llmModel({ deployment_name: 'claude-sonnet-5', label: 'Claude Sonnet 5', multimodal: true }),
    );

    expect(entry.id).toBe('claude-sonnet-5');
    expect(entry.name).toBe('Claude Sonnet 5');
    expect(entry.input).toEqual(['text', 'image']);
    expect(entry.reasoning).toBe(true);
    expect(entry.compat).toEqual({ forceAdaptiveThinking: true });
  });
});
