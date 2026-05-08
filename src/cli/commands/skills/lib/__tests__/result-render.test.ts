/**
 * Unit tests for the pure renderer used by `codemie skills find`.
 *
 * Spec §6 requires:
 *   - "EPAM Internal" header rendered first, then "Public (skills.sh)"
 *   - configured-but-unavailable internal differs from "no URL configured"
 *   - public failure text matches "Public search unavailable. Try again later."
 *   - --json mode produces a stable shape and no ANSI
 *   - install hint trailer is always present in the human path
 */

import { describe, expect, it } from 'vitest';
import { renderSections, renderJson } from '../result-render.js';
import type { SearchSection } from '../skills-search-client.js';

// chalk emits SGR codes when FORCE_COLOR=1 (vitest config). The renderer is
// pure, so stripping ANSI is the simplest way to assert plain text output.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string): string => s.replace(ANSI, '');

const empty: SearchSection = { available: false, results: [] };

describe('renderSections', () => {
  it('puts the EPAM Internal header before Public (skills.sh)', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: empty,
        public: empty,
        internalConfigured: false,
      })
    );
    const internalIdx = out.indexOf('EPAM Internal');
    const publicIdx = out.indexOf('Public (skills.sh)');
    expect(internalIdx).toBeGreaterThan(-1);
    expect(publicIdx).toBeGreaterThan(internalIdx);
  });

  it('shows the friendly placeholder when internal is not configured', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: empty,
        public: empty,
        internalConfigured: false,
      })
    );
    expect(out).toContain('No internal results yet — internal catalog coming soon.');
  });

  it('shows "No internal results." when internal is configured but the call failed', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: { available: false, results: [] },
        public: empty,
        internalConfigured: true,
      })
    );
    expect(out).not.toContain('coming soon');
    expect(out).toContain('No internal results.');
  });

  it('renders public-unavailable text when public.available is false', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: empty,
        public: { available: false, results: [] },
        internalConfigured: false,
      })
    );
    expect(out).toContain('Public search unavailable. Try again later.');
  });

  it('renders result rows with source@name and the skills.sh URL', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: empty,
        public: {
          available: true,
          results: [
            {
              name: 'pdf',
              slug: 'anthropics/skills/pdf',
              source: 'anthropics/skills',
              installs: 93100,
            },
          ],
        },
        internalConfigured: false,
      })
    );
    expect(out).toContain('anthropics/skills@pdf');
    expect(out).toContain('https://skills.sh/anthropics/skills/pdf');
    // installs are humanised (93.1K)
    expect(out).toMatch(/93\.1K/);
  });

  it('emits the install hint trailer', () => {
    const out = strip(
      renderSections({
        query: 'pdf',
        internal: empty,
        public: empty,
        internalConfigured: false,
      })
    );
    expect(out).toContain('Install with: codemie skills add <owner/repo@skill>');
  });
});

describe('renderJson', () => {
  it('returns a serializable shape with both sections under `available` flags', () => {
    const obj = renderJson({
      query: 'pdf',
      internal: { available: false, results: [] },
      public: {
        available: true,
        results: [{ name: 'pdf', slug: 'a/b/pdf', source: 'a/b', installs: 1 }],
      },
      internalConfigured: false,
    });
    expect(obj.query).toBe('pdf');
    expect(obj.internal).toEqual({ available: false, results: [] });
    expect(obj.public.available).toBe(true);
    expect(obj.public.results[0]?.slug).toBe('a/b/pdf');

    // Stable JSON serialization (no ANSI, no functions).
    const json = JSON.stringify(obj);
    expect(json).not.toMatch(ANSI);
  });
});
