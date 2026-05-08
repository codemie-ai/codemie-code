/**
 * Pure formatters for `codemie skills find` output.
 *
 * Two surfaces:
 * - `renderSections` — chalk-colored two-section text for humans.
 * - `renderJson` — machine-readable shape for `--json`.
 *
 * Both are deterministic given the same input. The orchestrator owns
 * stdout/stderr writes and exit codes.
 */
import chalk from 'chalk';
import type { SearchSection, SkillSearchResult } from './skills-search-client.js';

const PLACEHOLDER_INTERNAL_NOT_CONFIGURED =
  'No internal results yet — internal catalog coming soon.';
const PUBLIC_UNAVAILABLE = 'Public search unavailable. Try again later.';
const NO_INTERNAL_RESULTS = 'No internal results.';
const NO_PUBLIC_RESULTS = 'No public results.';
const INSTALL_HINT = 'Install with: codemie skills add <owner/repo@skill>';

export interface RenderInput {
  query: string;
  internal: SearchSection;
  public: SearchSection;
  /**
   * `true` when an internal search URL is resolved (env var or config).
   * Distinguishes "no configured endpoint" (placeholder text) from
   * "configured endpoint, HTTP failed" (no-results message).
   */
  internalConfigured: boolean;
}

export interface JsonOutput {
  query: string;
  internal: { available: boolean; results: SkillSearchResult[] };
  public: { available: boolean; results: SkillSearchResult[] };
}

export function renderSections(input: RenderInput): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${chalk.dim('Searching for')} ${chalk.bold(`"${input.query}"`)}${chalk.dim('…')}`);
  lines.push('');

  lines.push(chalk.bold('EPAM Internal'));
  lines.push(...renderInternalBody(input));
  lines.push('');

  lines.push(chalk.bold('Public (skills.sh)'));
  lines.push(...renderPublicBody(input.public));
  lines.push('');

  lines.push(chalk.dim(INSTALL_HINT));
  lines.push('');
  return lines.join('\n');
}

export function renderJson(input: RenderInput): JsonOutput {
  return {
    query: input.query,
    internal: { available: input.internal.available, results: input.internal.results },
    public: { available: input.public.available, results: input.public.results },
  };
}

function renderInternalBody(input: RenderInput): string[] {
  if (!input.internalConfigured) {
    return [`  ${chalk.dim(PLACEHOLDER_INTERNAL_NOT_CONFIGURED)}`];
  }
  if (!input.internal.available || input.internal.results.length === 0) {
    return [`  ${chalk.dim(NO_INTERNAL_RESULTS)}`];
  }
  return formatResultBlock(input.internal.results);
}

function renderPublicBody(section: SearchSection): string[] {
  if (!section.available) {
    return [`  ${chalk.dim(PUBLIC_UNAVAILABLE)}`];
  }
  if (section.results.length === 0) {
    return [`  ${chalk.dim(NO_PUBLIC_RESULTS)}`];
  }
  return formatResultBlock(section.results);
}

function formatResultBlock(results: SkillSearchResult[]): string[] {
  return results.flatMap((result) => {
    const label =
      result.source && result.name ? `${result.source}@${result.name}` : result.slug;
    const installs = formatInstalls(result.installs);
    const headLine = installs ? `  ${label}  ${chalk.cyan(installs)}` : `  ${label}`;
    const detailLine = `    ${chalk.dim(`└ https://skills.sh/${result.slug}`)}`;
    return [headLine, detailLine];
  });
}

function formatInstalls(count: number | undefined): string {
  if (!count || count <= 0) return '';
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  }
  return `${count} install${count === 1 ? '' : 's'}`;
}
