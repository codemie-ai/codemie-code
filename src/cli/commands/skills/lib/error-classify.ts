/**
 * Maps stable upstream `skills` CLI failures to short error codes for metrics.
 *
 * Conservative by design: when the upstream wording changes, the wrapper
 * returns `unknown` rather than parsing fragile interactive output.
 */

import type { ExecResult } from '@/utils/exec.js';

export type SkillErrorCode =
  | 'egress_blocked'
  | 'skill_not_found'
  | 'git_fetch_timeout'
  | 'git_fetch_failed'
  | 'interrupted'
  | 'all_searches_failed'
  | 'unknown';

export interface ClassifyInput {
  result?: Pick<ExecResult, 'code' | 'stdout' | 'stderr' | 'signal'>;
  error?: unknown;
}

const EGRESS_MARKERS = ['CODEMIE_SKILL_EGRESS_BLOCKED', 'add-skill.vercel.sh'];
const TIMEOUT_MARKERS = ['CODEMIE_SKILLS_TIMEOUT', 'timed out'];
const NOT_FOUND_MARKERS = ['skill not found', 'no such skill', 'could not find skill'];
const GIT_FETCH_MARKERS = [
  'git clone',
  'git fetch',
  'failed to fetch',
  'unable to access',
  'could not resolve host',
  'remote: not found',
];

export function classifySkillError(input: ClassifyInput): SkillErrorCode {
  if (isInterrupted(input)) {
    return 'interrupted';
  }

  const haystack = collectHaystack(input).toLowerCase();

  if (containsAny(haystack, EGRESS_MARKERS)) {
    return 'egress_blocked';
  }

  if (containsAny(haystack, TIMEOUT_MARKERS)) {
    return 'git_fetch_timeout';
  }

  if (containsAny(haystack, NOT_FOUND_MARKERS)) {
    return 'skill_not_found';
  }

  if (containsAny(haystack, GIT_FETCH_MARKERS)) {
    return 'git_fetch_failed';
  }

  return 'unknown';
}

function isInterrupted(input: ClassifyInput): boolean {
  if (input.result?.signal === 'SIGINT' || input.result?.signal === 'SIGTERM') {
    return true;
  }
  if (input.result?.code === 130) {
    return true;
  }
  if (input.error instanceof Error && /terminated by signal/i.test(input.error.message)) {
    return true;
  }
  return false;
}

function collectHaystack(input: ClassifyInput): string {
  const parts: string[] = [];
  if (input.result?.stderr) parts.push(input.result.stderr);
  if (input.result?.stdout) parts.push(input.result.stdout);
  if (input.error instanceof Error) parts.push(input.error.message);
  else if (typeof input.error === 'string') parts.push(input.error);
  return parts.join('\n');
}

function containsAny(haystack: string, markers: readonly string[]): boolean {
  return markers.some((marker) => haystack.includes(marker.toLowerCase()));
}
