/**
 * Codex deployment-name resolution.
 * @group unit
 */
import { describe, expect, it } from 'vitest';
import { resolveCodexDeployment } from '../codex-model-resolver.js';

const AVAILABLE = [
  'gpt-5-1-codex-2025-11-13',
  'gpt-5-2-2025-12-11',
  'gpt-5-2025-08-07',
  'gpt-5-mini-2025-08-07',
  'gpt-5-nano-2025-08-07',
  'gpt-5.4-2026-03-05',
  'gpt-5.5-2026-04-24',
  'gpt-5.6-luna-2026-07-09',
  'gpt-5.6-sol-2026-07-09',
  'gpt-5.6-terra-2026-07-09',
];

describe('resolveCodexDeployment', () => {
  it('passes an already-valid dated deployment name through untouched', () => {
    expect(resolveCodexDeployment('gpt-5.6-sol-2026-07-09', AVAILABLE, 'gpt-5.6-luna-2026-07-09'))
      .toEqual({ model: 'gpt-5.6-sol-2026-07-09', kind: 'exact' });
  });

  it('maps an undated named variant to its dated deployment', () => {
    expect(resolveCodexDeployment('gpt-5.6-luna', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5.6-luna-2026-07-09', kind: 'resolved' });
    expect(resolveCodexDeployment('gpt-5.6-terra', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5.6-terra-2026-07-09', kind: 'resolved' });
  });

  it('normalizes dotted minor versions to the dashed deployment form', () => {
    expect(resolveCodexDeployment('gpt-5.2', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5-2-2025-12-11', kind: 'resolved' });
    expect(resolveCodexDeployment('gpt-5.5', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5.5-2026-04-24', kind: 'resolved' });
  });

  it('does not confuse a bare major version with a minor or a variant', () => {
    // gpt-5 must not resolve to gpt-5-2, gpt-5-mini or gpt-5-1-codex.
    expect(resolveCodexDeployment('gpt-5', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5-2025-08-07', kind: 'resolved' });
  });

  it('keeps reduced-capacity variants distinct', () => {
    expect(resolveCodexDeployment('gpt-5-mini', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({ model: 'gpt-5-mini-2025-08-07', kind: 'resolved' });
  });

  it('falls back to the pinned model when nothing matches', () => {
    expect(resolveCodexDeployment('gpt-4o', AVAILABLE, 'gpt-5.6-sol-2026-07-09'))
      .toEqual({
        model: 'gpt-5.6-sol-2026-07-09',
        kind: 'substituted',
        requested: 'gpt-4o',
      });
  });

  it('leaves the request alone when there is no pinned fallback and no match', () => {
    expect(resolveCodexDeployment('gpt-4o', AVAILABLE, undefined))
      .toEqual({ model: 'gpt-4o', kind: 'unresolved' });
  });

  it('passes through when the available list is empty', () => {
    expect(resolveCodexDeployment('gpt-5.6-luna', [], undefined))
      .toEqual({ model: 'gpt-5.6-luna', kind: 'unresolved' });
  });
});

describe('rankDeploymentsByRecency', () => {
  it('puts the newest generation first and reduced-capacity variants last', async () => {
    const { rankDeploymentsByRecency } = await import('../codex-model-resolver.js');

    expect(rankDeploymentsByRecency(AVAILABLE)[0]).toBe('gpt-5.6-luna-2026-07-09');
    expect(rankDeploymentsByRecency(['gpt-5-mini-2025-08-07', 'gpt-5-2025-08-07'])[0])
      .toBe('gpt-5-2025-08-07');
  });

  it('returns an empty list unchanged', async () => {
    const { rankDeploymentsByRecency } = await import('../codex-model-resolver.js');
    expect(rankDeploymentsByRecency([])).toEqual([]);
  });
});

describe('deployment names with a suffix after the release date', () => {
  it('does not let a trailing suffix reintroduce the date-as-version inversion', async () => {
    const { rankDeploymentsByRecency, resolveCodexDeployment } = await import('../codex-model-resolver.js');
    const list = ['gpt-5-2025-08-07-preview', 'gpt-5.6-luna-2026-07-09'];

    // gpt-5-...-preview must parse as major 5 / minor 0, not minor 2025.
    expect(rankDeploymentsByRecency(list)[0]).toBe('gpt-5.6-luna-2026-07-09');
    expect(resolveCodexDeployment('gpt-5.6-luna', list, undefined).model)
      .toBe('gpt-5.6-luna-2026-07-09');
  });

  it('prefers the newest deployment when several share one identity', async () => {
    const { resolveCodexDeployment } = await import('../codex-model-resolver.js');
    // Gateway order is arbitrary and often lists the oldest first.
    const list = ['gpt-5.6-luna-2026-01-01', 'gpt-5.6-luna-2026-07-09'];

    expect(resolveCodexDeployment('gpt-5.6-luna', list, undefined))
      .toEqual({ model: 'gpt-5.6-luna-2026-07-09', kind: 'resolved' });
  });
});
