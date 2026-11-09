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

// Exact skill/command/agent names from the external sdlc-factory bundle — distinct from the
// namespaced form seen on skill/agent invocations (Claude namespaces with `sdlc-factory:`,
// oh-my-pi with `sdlc-factory/`). Lists come from the plugin's own skills/ and agents/ trees;
// generic names (`code-review`, `memory`, `product-owner`) are deliberately excluded.
const SDLC_FACTORY_NAMES = [
  // commands
  'sdlc-light',
  'sdlc-standard',
  'sdlc-task',
  'sdlc-autonomous',
  'sdlc-doctor',
  'sdlc-status',
  // unnamespaced skills
  'babysit-mr',
  'complexity-calibrate',
  'complexity-scoring',
  'complexity-scoring-manual',
  'feature-verification',
  'knowledge-auditor',
  'knowledge-foundation',
  'knowledge-keeper',
  'mr-creator',
  'qa-case-generator',
  'qa-complexity-scoring',
  'qa-e2e-generator',
  'qa-foundation',
  'qa-gates',
  'tech-analysis-orchestrator',
  // agents
  'code-review-orchestrator',
  'complexity-assessor',
  'feature-verification-runner',
  'implementation-inline',
  'implementation-subagent',
  'knowledge-harvester',
  'knowledge-keeper-runner',
  'plan-writer',
  'preflight-runner',
  'product-owner-stand-in',
  'qa-complexity-assessor',
  'qa-gates-runner',
  'review-lens-acceptance',
  'review-lens-blind',
  'review-lens-edge-case',
  'review-lens-verification-gap',
  'review-standards',
  'review-triage',
  'spec-writer',
  'tech-analyst-codegraph',
  'tech-analyst-filesystem',
  'tech-lead-stand-in',
];

// SecOps plugin skills/agents, minus generic names (`security-review`, `jira-ops`, `cleanup`, `test-run`).
const SECOPS_NAMES = [
  'container-cve-fix',
  'sast-fix',
  'secret-fix',
  'security-classify',
  'security-preflight',
  'security-remediate',
  'image-builder',
  'security-fixer',
  'trivy-scan',
  'trufflehog-scan',
  'verify-citation',
];

// `mattpocock/skills`, minus generic names (`code-review`, `tdd`, `implement`, `pr`, `research`,
// `triage`, `handoff`, `prototype`, `teach`, `retro`, `wizard`).
const MATT_POCOCK_SKILL_NAMES = [
  'ask-matt',
  'chief-of-staff',
  'claude-handoff',
  'codebase-design',
  'diagnosing-bugs',
  'domain-modeling',
  'git-guardrails-claude-code',
  'grill-me',
  'grill-with-docs',
  'grilling',
  'implement-spec',
  'improve-codebase-architecture',
  'loop-me',
  'migrate-to-shoehorn',
  'scaffold-exercises',
  'setup-matt-pocock-skills',
  'setup-pre-commit',
  'setup-ts-deep-modules',
  'to-questionnaire',
  'to-spec',
  'to-tickets',
  'wait-what',
  'wayfinder',
  'writing-beats',
  'writing-for-agents',
  'writing-fragments',
  'writing-shape',
];

export const SESSION_SOURCE_DETECTORS: SessionSourceDetector[] = [
  {
    name: 'sdlc-factory',
    label: 'CodeMie AI Factory',
    matches: (names) =>
      hasPrefix(names, 'sdlc-factory:') ||
      hasPrefix(names, 'sdlc-factory/') ||
      hasPrefix(names, 'sdlc-local:') ||
      hasPrefix(names, 'sdlc-local/') ||
      hasExact(names, SDLC_FACTORY_NAMES),
  },
  {
    name: 'superpowers',
    label: 'Superpowers',
    matches: (names) => hasPrefix(names, 'superpowers:') || hasPrefix(names, 'superpowers/'),
  },
  {
    name: 'secops',
    label: 'SecOps',
    matches: (names) => hasPrefix(names, 'secops:') || hasPrefix(names, 'secops/') || hasExact(names, SECOPS_NAMES),
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
  {
    name: 'matt-pocock-skills',
    label: 'Matt Pocock Skills',
    matches: (names) => hasExact(names, MATT_POCOCK_SKILL_NAMES),
  },
  {
    name: 'caveman',
    label: 'Caveman',
    matches: (names) => hasPrefix(names, 'caveman'),
  },
  {
    name: 'ponytail',
    label: 'Ponytail',
    matches: (names) => hasPrefix(names, 'ponytail'),
  },
  {
    name: 'codemie-skills',
    label: 'CodeMie Skills',
    matches: (names) => hasPrefix(names, 'codemie-') || hasPrefix(names, 'codemie:') || hasPrefix(names, 'codemie/'),
  },
  {
    name: 'herdr',
    label: 'Herdr',
    matches: (names) => hasExact(names, ['herdr']) || hasPrefix(names, 'herdr:') || hasPrefix(names, 'herdr/'),
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
