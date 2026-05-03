export interface PriorityPattern {
  pattern: RegExp;
  weight: number;
}

export const ERROR_KEYWORDS: ReadonlySet<string> = new Set([
  'error', 'exception', 'fatal', 'failure', 'fail', 'failed',
  'traceback', 'stacktrace', 'stack trace', 'critical', 'crash',
  'panic', 'segfault', 'abort', 'timeout', 'denied', 'rejected',
  'null pointer', 'undefined', 'cannot', 'unable',
]);

export const WARNING_KEYWORDS: ReadonlySet<string> = new Set([
  'warning', 'warn', 'deprecated', 'deprecation', 'caution',
  'notice', 'attention', 'important',
]);

export const IMPORTANCE_KEYWORDS: ReadonlySet<string> = new Set([
  'important', 'note', 'summary', 'result', 'output', 'conclusion',
  'solution', 'fix', 'resolved', 'todo', 'fixme', 'hack', 'xxx',
]);

export const SECURITY_KEYWORDS: ReadonlySet<string> = new Set([
  'api_key', 'api key', 'secret', 'password', 'credential', 'auth',
  'private_key', 'access_key', 'bearer', 'authorization',
]);

const _errorAlt = [
  'error', 'exception', 'fatal', 'failure', 'fail', 'failed',
  'traceback', 'stacktrace', 'critical', 'crash', 'panic',
  'abort', 'timeout', 'denied', 'rejected',
].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const _warningAlt = [
  'warning', 'warn', 'deprecated', 'deprecation',
].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const _importanceAlt = [
  'important', 'note', 'summary', 'result', 'output', 'conclusion',
  'solution', 'fix', 'resolved', 'todo', 'fixme',
].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

const _securityAlt = [
  'api_key', 'api key', 'secret', 'password', 'credential',
  'private_key', 'access_key', 'bearer', 'authorization',
].map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

export const ERROR_PATTERN: RegExp = new RegExp(`\\b(${_errorAlt})\\b`, 'i');
export const WARNING_PATTERN: RegExp = new RegExp(`\\b(${_warningAlt})\\b`, 'i');
export const IMPORTANCE_PATTERN: RegExp = new RegExp(`\\b(${_importanceAlt})\\b`, 'i');
export const SECURITY_PATTERN: RegExp = new RegExp(`(${_securityAlt})`, 'i');

export const PRIORITY_PATTERNS_DIFF: PriorityPattern[] = [
  { pattern: ERROR_PATTERN, weight: 1.0 },
  { pattern: WARNING_PATTERN, weight: 0.7 },
  { pattern: SECURITY_PATTERN, weight: 0.9 },
  { pattern: /^[+-]\s*\S/, weight: 0.05 },
];

export const PRIORITY_PATTERNS_SEARCH: PriorityPattern[] = [
  { pattern: ERROR_PATTERN, weight: 1.0 },
  { pattern: WARNING_PATTERN, weight: 0.7 },
  { pattern: IMPORTANCE_PATTERN, weight: 0.5 },
  { pattern: SECURITY_PATTERN, weight: 0.9 },
];

export function contentHasErrorIndicators(text: string): boolean {
  const lower = text.toLowerCase();
  for (const kw of ERROR_KEYWORDS) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

type ScoreCategory = 'error' | 'warning' | 'importance' | 'security' | null;

export function scoreLine(
  line: string,
  _context: string = 'text',
): [ScoreCategory, number, number] {
  if (ERROR_PATTERN.test(line)) return ['error', 1.0, 1.0];
  if (SECURITY_PATTERN.test(line)) return ['security', 0.9, 0.9];
  if (WARNING_PATTERN.test(line)) return ['warning', 0.7, 0.8];
  if (IMPORTANCE_PATTERN.test(line)) return ['importance', 0.5, 0.7];
  return [null, 0.0, 0.0];
}
