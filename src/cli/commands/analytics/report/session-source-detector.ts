/**
 * Session-source classification: labels each session by the SDLC tooling/framework
 * signal found in its skill/agent/command invocation names. Ordered, first-match-wins
 * strategy list — new bundles register by adding an entry here, not by editing a
 * branching if/else chain. Detection is name-based only (skill/agent/command names
 * already captured by the report pipeline); it does not inspect the filesystem.
 */

import type { NamedInvocationStats } from '../types.js';

export interface SessionInvocationNames {
  skillInvocations: NamedInvocationStats[];
  agentInvocations: NamedInvocationStats[];
  commandInvocations: NamedInvocationStats[];
}

export interface SessionSourceDetector {
  /** Stable id, e.g. 'sdlc-factory'. */
  name: string;
  /** Display label shown in the report's Source column when this detector matches. */
  label: string;
  /** True if any invocation name (already lowercased) signals this bundle. */
  matches(names: string[]): boolean;
}

export const PURE_CHAT_LABEL = 'Pure chat';

function collectNames(session: SessionInvocationNames): string[] {
  return [...session.skillInvocations, ...session.agentInvocations, ...session.commandInvocations].map((n) =>
    n.name.toLowerCase()
  );
}

function hasPrefix(names: string[], prefix: string): boolean {
  return names.some((n) => n.startsWith(prefix));
}

function hasExact(names: string[], candidates: string[]): boolean {
  return names.some((n) => candidates.includes(n));
}

function hasSubstring(names: string[], substrings: string[]): boolean {
  return names.some((n) => substrings.some((s) => n.includes(s)));
}

// Unnamespaced slash commands from the external sdlc-factory skill bundle — distinct
// from the namespaced `sdlc-factory:` prefix seen on skill/agent invocations.
const SDLC_FACTORY_COMMANDS = ['sdlc-light', 'sdlc-task', 'sdlc-autonomous'];

export const SESSION_SOURCE_DETECTORS: SessionSourceDetector[] = [
  {
    name: 'sdlc-factory',
    label: 'CodeMie AI Factory',
    matches: (names) => hasPrefix(names, 'sdlc-factory:') || hasExact(names, SDLC_FACTORY_COMMANDS),
  },
  {
    name: 'superpowers',
    label: 'Superpowers',
    matches: (names) => hasPrefix(names, 'superpowers:'),
  },
  {
    name: 'openspec',
    label: 'OpenSpec',
    matches: (names) => hasSubstring(names, ['openspec', 'open-spec']),
  },
  {
    name: 'speckit',
    label: 'SpecKit',
    matches: (names) => hasSubstring(names, ['speckit', 'spec-kit']),
  },
  {
    name: 'bmad',
    label: 'BMAD',
    matches: (names) => hasSubstring(names, ['bmad']),
  },
];

/**
 * Classify a session's tooling/framework source. Detectors are tried in order;
 * the first match wins. Falls back to {@link PURE_CHAT_LABEL} when none match.
 */
export function detectSessionSource(
  session: SessionInvocationNames,
  detectors: SessionSourceDetector[] = SESSION_SOURCE_DETECTORS
): string {
  const names = collectNames(session);
  for (const detector of detectors) {
    if (detector.matches(names)) {
      return detector.label;
    }
  }
  return PURE_CHAT_LABEL;
}
