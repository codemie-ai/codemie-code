/**
 * Resolves where analytics report files go for the `-o, --output <path>` flag.
 * Pure path computation only — the caller is responsible for creating directories
 * and actually writing the files. See docs/superpowers/tasks/2026-09-26-unify-analytics-cost-command/spec.md, section A.
 */

import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { getDefaultReportJsonPath, getDefaultReportPath } from './report-generator.js';

export type ExportFormat = 'html' | 'json' | 'both';

export interface OutputTargets {
  html?: string;
  json?: string;
  isDefault: boolean;
}

/** True when `path` exists and is a directory. A missing path is treated as "not a directory". */
function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Computes the html/json target paths for `--export <format> -o <output>`.
 *
 * - No `output`: default names in `cwd` (`getDefaultReportPath`/`getDefaultReportJsonPath`), `isDefault: true`.
 * - Directory target (`output` ends with a path separator, or names an existing directory):
 *   each requested format goes inside it under its default name.
 * - File target (anything else): `html`/`json` use the path as given; `both` strips a trailing
 *   `.html`/`.json` and writes `<base>.html` + `<base>.report.json`.
 */
export function resolveOutputTargets(
  format: ExportFormat,
  output: string | undefined,
  cwd: string,
  userEmail?: string
): OutputTargets {
  const wantsHtml = format === 'html' || format === 'both';
  const wantsJson = format === 'json' || format === 'both';

  if (output === undefined) {
    return {
      ...(wantsHtml && { html: getDefaultReportPath(cwd, userEmail) }),
      ...(wantsJson && { json: getDefaultReportJsonPath(cwd, userEmail) }),
      isDefault: true,
    };
  }

  const resolvedPath = resolve(cwd, output);
  const isDirectoryTarget =
    output.endsWith(sep) || output.endsWith('/') || isExistingDirectory(resolvedPath);

  if (isDirectoryTarget) {
    return {
      ...(wantsHtml && { html: getDefaultReportPath(resolvedPath, userEmail) }),
      ...(wantsJson && { json: getDefaultReportJsonPath(resolvedPath, userEmail) }),
      isDefault: false,
    };
  }

  if (format === 'both') {
    const base = resolvedPath.replace(/\.(html|json)$/i, '');
    return { html: `${base}.html`, json: `${base}.report.json`, isDefault: false };
  }

  return {
    ...(wantsHtml && { html: resolvedPath }),
    ...(wantsJson && { json: resolvedPath }),
    isDefault: false,
  };
}
