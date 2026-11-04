/**
 * The lead's flow package: `flow-template/` with `Flow_config.inputs` filled in, zipped for
 * Power Automate's Import Package (Legacy).
 *
 * Ported from the standalone collector's `src/flow-template.js` + `src/zip.js`
 * (codemie-analytics-collector). `Flow_config.inputs` is set on the parsed definition JSON,
 * never by string substitution, so a folder name containing quotes or backslashes cannot
 * break the JSON. The template directory itself ships as a byte-identical copy of the
 * collector's `flow/template/` (see scripts/copy-plugins.js) and is never modified here.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { zipSync } from 'fflate';

import { ConfigurationError } from '@/utils/errors.js';
import { getDirname } from '@/utils/paths.js';

/** Written into the current folder by the import step; overwritten (with a notice) on
 * re-run. */
export const FLOW_PACKAGE_FILENAME = 'codemie-analytics-flow.zip';

/** The settings the lead's wizard collects, written onto the template's `Flow_config`
 * action so the imported flow knows where to deliver. */
export interface FlowConfigInputs {
  siteUrl: string;
  folderPath: string;
  teamId: string;
  channelId: string;
  timeZone: string;
}

const FLOW_CONFIG_ACTION = 'Flow_config';
const DEFINITION_PATH = /^Microsoft\.Flow\/flows\/[^/]+\/definition\.json$/;

/** Never walked into: version control, if a stray copy were ever present. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

/**
 * Every file under `dir`, as sorted paths relative to it with forward slashes — the form
 * both the zip entry names and `DEFINITION_PATH` expect, on every platform.
 */
function listTemplateFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  };
  walk('');
  return found.sort();
}

/**
 * The bundled flow template directory, shipped next to this module's compiled output (see
 * scripts/copy-plugins.js's `dirConfigs` entry) and resolved at runtime via
 * `import.meta.url` so it works both from `src/` (vitest) and from `dist/` (the published
 * build). Throws {@link ConfigurationError} if the directory is missing — a broken install
 * rather than a user mistake.
 */
export function resolveFlowTemplateDir(): string {
  const dir = join(getDirname(import.meta.url), 'flow-template');
  if (!existsSync(dir)) {
    throw new ConfigurationError(`Flow template directory not found: ${dir}`);
  }
  return dir;
}

/**
 * The importable package, as zip bytes, with `Flow_config.inputs` set from `inputs` on the
 * template's `definition.json`. The other template files are copied through unchanged.
 * `templateDir` defaults to {@link resolveFlowTemplateDir} and is only overridden by tests.
 */
export async function buildFlowPackage(inputs: FlowConfigInputs, templateDir?: string): Promise<Uint8Array> {
  const dir = templateDir ?? resolveFlowTemplateDir();
  const names = listTemplateFiles(dir);
  const definitionName = names.find((name) => DEFINITION_PATH.test(name));
  if (!definitionName) {
    throw new ConfigurationError(`Flow template has no definition.json under ${dir}`);
  }

  const entries: Record<string, Uint8Array> = {};
  for (const name of names) {
    const data = readFileSync(join(dir, name));
    if (name !== definitionName) {
      entries[name] = new Uint8Array(data);
      continue;
    }

    const flow = JSON.parse(data.toString('utf-8'));
    const action = flow?.properties?.definition?.actions?.[FLOW_CONFIG_ACTION];
    if (!action) {
      throw new ConfigurationError(`Flow template's ${name} has no ${FLOW_CONFIG_ACTION} action`);
    }
    action.inputs = { ...inputs };
    entries[name] = new TextEncoder().encode(`${JSON.stringify(flow, null, 2)}\n`);
  }

  return zipSync(entries, { level: 0 });
}

/**
 * Writes the flow package into `dir` (the lead's current folder) as
 * {@link FLOW_PACKAGE_FILENAME}. Reports whether an existing file was overwritten so the
 * caller can print a notice — the spec requires the output to say so on a re-run.
 */
export async function writeFlowPackage(
  dir: string,
  inputs: FlowConfigInputs
): Promise<{ path: string; overwritten: boolean }> {
  const path = join(dir, FLOW_PACKAGE_FILENAME);
  const overwritten = existsSync(path);
  const data = await buildFlowPackage(inputs);
  writeFileSync(path, data);
  return { path, overwritten };
}
