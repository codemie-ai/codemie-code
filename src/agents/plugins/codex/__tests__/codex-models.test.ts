/**
 * Codex model resolution (src/agents/plugins/codex/codex-models.ts).
 *
 * Pins the pure predicates (isCodexCompatibleModelName), the two independent
 * ranking paths (rankCodexModelIdsByRecency for display, and the internal
 * rankModel/compareRankedModels path exercised through resolveCodexModel), the
 * ~/.codex/codemie/models.json catalog write, and assertExplicitCodexModelAllowed.
 *
 * fetchCodeMieLlmModels is mocked (vi.hoisted + importOriginal) so nothing hits
 * the network, and HOME is redirected to a mkdtemp dir so the catalog write
 * never touches the developer's real ~/.codex. Expected values were captured by
 * running the compiled code first — these tests pin CURRENT behavior, including
 * the known date-masquerades-as-minor-version quirk in the CLI ranking path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

// Mock the catalog fetch so resolveCodexModel never hits the network. Spread the
// original module so its other exports (types, other fns) remain intact.
const fetchMock = vi.hoisted(() => vi.fn<() => Promise<LlmModel[]>>());
vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>();
  return { ...actual, fetchCodeMieLlmModels: fetchMock };
});

import {
  isCodexCompatibleModelName,
  rankCodexModelIdsByRecency,
  resolveCodexModel,
  assertExplicitCodexModelAllowed,
} from '../codex-models.js';

/** Minimal LlmModel factory (only the fields the reader touches). */
function model(fields: Partial<LlmModel>): LlmModel {
  return { enabled: true, ...fields } as unknown as LlmModel;
}

// JWT-auth env so fetchCodeMieModelsForCodex takes the fetch path.
const jwtEnv = { CODEMIE_JWT_TOKEN: 'tok', CODEMIE_BASE_URL: 'https://host/code-assistant-api' };

describe('isCodexCompatibleModelName', () => {
  it('accepts GPT-5/GPT-6/Codex names', () => {
    expect(isCodexCompatibleModelName('gpt-5')).toBe(true);
    expect(isCodexCompatibleModelName('gpt-5-codex')).toBe(true);
    expect(isCodexCompatibleModelName('gpt-6')).toBe(true);
    expect(isCodexCompatibleModelName('gpt-5.6-luna')).toBe(true);
  });

  it('rejects other providers, GPT-4, empty, and undefined', () => {
    expect(isCodexCompatibleModelName('claude-sonnet')).toBe(false);
    expect(isCodexCompatibleModelName('gemini-3')).toBe(false);
    expect(isCodexCompatibleModelName('gpt-4o')).toBe(false);
    expect(isCodexCompatibleModelName('')).toBe(false);
    expect(isCodexCompatibleModelName(undefined)).toBe(false);
  });

  it('an incompatible-provider token anywhere in the name disqualifies it', () => {
    // INCOMPATIBLE patterns are checked before COMPATIBLE ones.
    expect(isCodexCompatibleModelName('gpt-5-codex anthropic')).toBe(false);
  });
});

describe('rankCodexModelIdsByRecency (display path — newest first)', () => {
  it('ranks newest generation first, sinks mini/nano, drops disabled & incompatible', () => {
    const ids = rankCodexModelIdsByRecency([
      model({ deployment_name: 'gpt-5-2025-08-07', base_name: 'gpt-5', label: 'GPT-5' }),
      model({ deployment_name: 'gpt-5.6-luna-2026-07-09', base_name: 'gpt-5.6', label: 'GPT 5.6' }),
      model({ deployment_name: 'gpt-5-codex-2026-01-01', base_name: 'gpt-5-codex', label: 'GPT-5 Codex' }),
      model({ deployment_name: 'gpt-5-mini-2026-02-02', base_name: 'gpt-5-mini', label: 'GPT-5 mini' }),
      model({ deployment_name: 'claude-sonnet-4-6', base_name: 'claude', label: 'Claude' }),
      model({ enabled: false, deployment_name: 'gpt-6-disabled', base_name: 'gpt-6', label: 'x' }),
    ]);
    // Highest generation (5.6) wins; mini sorts below full models of same gen;
    // claude (incompatible) and the disabled gpt-6 are excluded.
    expect(ids).toEqual([
      'gpt-5.6-luna-2026-07-09',
      'gpt-5-codex-2026-01-01',
      'gpt-5-2025-08-07',
      'gpt-5-mini-2026-02-02',
    ]);
  });

  it('returns an empty array when nothing is compatible', () => {
    expect(rankCodexModelIdsByRecency([
      model({ deployment_name: 'claude', base_name: 'claude', label: 'C' }),
      model({ deployment_name: 'gemini-3', base_name: 'gemini-3', label: 'G' }),
    ])).toEqual([]);
  });
});

describe('assertExplicitCodexModelAllowed', () => {
  const avail = ['gpt-5', 'gpt-5-codex'];

  it('accepts a compatible, available model', () => {
    expect(() => assertExplicitCodexModelAllowed('gpt-5', avail)).not.toThrow();
  });

  it('rejects an incompatible model as not compatible, suggesting available ones', () => {
    expect(() => assertExplicitCodexModelAllowed('claude', avail)).toThrow(/not compatible with codemie-codex/i);
    expect(() => assertExplicitCodexModelAllowed('claude', avail)).toThrow(/gpt-5, gpt-5-codex/);
  });

  it('rejects a compatible model that is not in the catalog', () => {
    expect(() => assertExplicitCodexModelAllowed('gpt-6', avail)).toThrow(/not available in CodeMie/i);
    expect(() => assertExplicitCodexModelAllowed('gpt-6', avail)).toThrow(/gpt-5, gpt-5-codex/);
  });

  it('skips the availability check when the list is empty', () => {
    expect(() => assertExplicitCodexModelAllowed('gpt-6', [])).not.toThrow();
  });
});

describe('resolveCodexModel (fetch mocked, HOME isolated)', () => {
  let tmpHome: string;
  let oldHome: string | undefined;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock.mockReset();
    tmpHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = tmpHome;
    stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stderr.mockRestore();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('selects the top-ranked model and writes the catalog under ~/.codex/codemie', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5-codex-2026-01-01', base_name: 'gpt-5-codex', label: 'GPT-5 Codex', multimodal: true }),
    ]);

    const r = await resolveCodexModel({ ...jwtEnv });

    expect(r.selectedModel).toBe('gpt-5-codex-2026-01-01');
    expect(r.availableModels).toEqual(['gpt-5-codex-2026-01-01']);
    expect(r.catalogPath).toBe(join(homedir(), '.codex/codemie/models.json'));
    expect(existsSync(r.catalogPath!)).toBe(true);
    // homedir() resolves via HOME → the write stayed inside the temp dir.
    expect(r.catalogPath!.startsWith(tmpHome)).toBe(true);

    const catalog = JSON.parse(readFileSync(r.catalogPath!, 'utf-8'));
    expect(catalog.models).toHaveLength(1);
    const entry = catalog.models[0];
    expect(entry.slug).toBe('gpt-5-codex-2026-01-01');
    expect(entry.display_name).toBe('GPT-5 Codex');
    expect(entry.priority).toBe(0);
    expect(entry.supported_in_api).toBe(true);
    expect(entry.default_reasoning_level).toBe('medium');
    expect(entry.supported_reasoning_levels.map((l: { effort: string }) => l.effort))
      .toEqual(['low', 'medium', 'high', 'xhigh']);
    // multimodal → image modality included.
    expect(entry.input_modalities).toEqual(['text', 'image']);
  });

  it('emits text-only modalities for a non-multimodal model', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5-codex', base_name: 'gpt-5-codex', label: 'GPT-5 Codex' }),
    ]);
    const r = await resolveCodexModel({ ...jwtEnv });
    const catalog = JSON.parse(readFileSync(r.catalogPath!, 'utf-8'));
    expect(catalog.models[0].input_modalities).toEqual(['text']);
  });

  it('honors a configured model that is present in the ranked catalog (no override notice)', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5-codex', base_name: 'gpt-5-codex', label: 'GPT-5 Codex' }),
      model({ deployment_name: 'gpt-5-mini', base_name: 'gpt-5-mini', label: 'GPT-5 mini' }),
    ]);

    const r = await resolveCodexModel({ ...jwtEnv, CODEMIE_MODEL: 'gpt-5-mini' });

    expect(r.selectedModel).toBe('gpt-5-mini');
    expect(r.availableModels).toContain('gpt-5-mini');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('falls back to the top model and warns when the configured model is absent from the catalog', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5-codex', base_name: 'gpt-5-codex', label: 'GPT-5 Codex' }),
    ]);

    const r = await resolveCodexModel({ ...jwtEnv, CODEMIE_MODEL: 'gpt-6-preview' });

    expect(r.selectedModel).toBe('gpt-5-codex');
    const notice = stderr.mock.calls.map(c => String(c[0])).join('\n');
    expect(notice).toMatch(/Requested model "gpt-6-preview" is not available/);
    expect(notice).toMatch(/using gpt-5-codex instead/);
  });

  it('applies the pinned gpt-5.4 preference bonus in the CLI ranking path', async () => {
    // The internal rankModel path gives gpt-5.4 a fixed bonus, so it wins even
    // over deployments carrying a newer embedded date (current documented behavior).
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'gpt-5-2025-08-07', base_name: 'gpt-5', label: 'GPT-5' }),
      model({ deployment_name: 'gpt-5.6-luna-2026-07-09', base_name: 'gpt-5.6', label: 'GPT 5.6' }),
      model({ deployment_name: 'gpt-5-4-turbo', base_name: 'gpt-5-4', label: 'GPT 5.4' }),
    ]);
    const r = await resolveCodexModel({ ...jwtEnv });
    expect(r.selectedModel).toBe('gpt-5-4-turbo');
    expect(r.availableModels[0]).toBe('gpt-5-4-turbo');
  });

  it('keeps a compatible configured model (no catalog write) when the fetch fails', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const r = await resolveCodexModel({ ...jwtEnv, CODEMIE_MODEL: 'gpt-5-codex' });

    expect(r.selectedModel).toBe('gpt-5-codex');
    expect(r.availableModels).toEqual(['gpt-5-codex']);
    expect(r.catalogPath).toBeUndefined();
    expect(existsSync(join(homedir(), '.codex/codemie/models.json'))).toBe(false);
  });

  it('rethrows when the fetch fails and no compatible model is configured', async () => {
    const err = new Error('boom');
    fetchMock.mockRejectedValueOnce(err);
    await expect(resolveCodexModel({ ...jwtEnv, CODEMIE_MODEL: 'claude' })).rejects.toThrow('boom');
  });

  it('keeps a compatible configured model when the catalog has no compatible models', async () => {
    fetchMock.mockResolvedValue([
      model({ deployment_name: 'claude', base_name: 'claude', label: 'Claude' }),
    ]);
    const r = await resolveCodexModel({ ...jwtEnv, CODEMIE_MODEL: 'gpt-5-codex' });
    expect(r.selectedModel).toBe('gpt-5-codex');
    expect(r.availableModels).toEqual(['gpt-5-codex']);
    expect(r.catalogPath).toBeUndefined();
  });

  it('throws a ConfigurationError when the catalog is empty and no compatible model is configured', async () => {
    fetchMock.mockResolvedValue([]);
    await expect(resolveCodexModel({ ...jwtEnv })).rejects.toThrow(/No CodeMie GPT\/Codex model is available/i);
  });

  it('returns an empty result path with no auth env and no configured model', async () => {
    // No JWT/SSO env → fetchCodeMieModelsForCodex returns [] without any network call.
    await expect(resolveCodexModel({})).rejects.toThrow(/No CodeMie GPT\/Codex model is available/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
