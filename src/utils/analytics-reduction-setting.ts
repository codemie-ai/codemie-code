import { promises as fs } from 'fs';
import path from 'path';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { writeFileAtomic } from '@/utils/atomic-write.js';
import { getCodemiePath } from '@/utils/paths.js';

/** `analytics.promptReduction` of one config file: strictly `true` is on, an unreadable file is `unreadable`. */
export type ReductionRead = 'on' | 'off' | 'unreadable';

const CONFIG_FILE = 'codemie-cli.config.json';
const PROJECT_DIR = '.codemie';
const OPTED_IN_FILE = 'analytics-reduction-projects.json';

/** Files already warned about while they stay unreadable (per process; the setting itself is never cached). */
const warnedUnreadable = new Set<string>();

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type ParsedFile = { kind: 'missing' } | { kind: 'unreadable' } | { kind: 'ok'; raw: string; value: Record<string, unknown> };

async function readConfigObject(file: string): Promise<ParsedFile> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? { kind: 'ok', raw, value } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** Reads the flag from one config file. A missing file or key is `off`. */
export async function readReductionFlag(configFile: string): Promise<ReductionRead> {
  const parsed = await readConfigObject(configFile);
  if (parsed.kind === 'missing') return 'off';
  if (parsed.kind === 'unreadable') return 'unreadable';
  const analytics = parsed.value['analytics'];
  return isRecord(analytics) && analytics['promptReduction'] === true ? 'on' : 'off';
}

function projectConfigFile(configDir: string): string {
  return path.basename(configDir) === PROJECT_DIR
    ? path.join(configDir, CONFIG_FILE)
    : path.join(configDir, PROJECT_DIR, CONFIG_FILE);
}

/**
 * Whether prompt reduction applies: the global file or any given project config dir has it on.
 * Each entry is a project dir (holding `.codemie/`) or its `.codemie` dir; undefined, empty and
 * duplicate entries are skipped. An unreadable file counts as on and warns once until it reads clean.
 */
export async function isReductionOn(opts: { configDirs: Array<string | undefined> }): Promise<boolean> {
  const files = new Set<string>([getCodemiePath(CONFIG_FILE)]);
  for (const dir of opts.configDirs) {
    if (dir) files.add(projectConfigFile(dir));
  }

  let on = false;
  for (const file of files) {
    const state = await readReductionFlag(file);
    if (state === 'unreadable') {
      if (!warnedUnreadable.has(file)) {
        warnedUnreadable.add(file);
        logger.warn('[analytics] Prompt reduction setting file unreadable; reducing prompts', { path: file });
      }
      on = true;
    } else {
      warnedUnreadable.delete(file);
      if (state === 'on') on = true;
    }
  }
  return on;
}

function detectIndent(raw: string): string | number {
  const match = /^[ \t]+(?=")/m.exec(raw);
  return match ? match[0] : raw.includes('\n') ? 2 : 0;
}

/** Sets `analytics.promptReduction`, keeping every other key, the file's indentation and its trailing newline. */
async function writeFlag(file: string, value: boolean): Promise<void> {
  const parsed = await readConfigObject(file);
  if (parsed.kind === 'unreadable') {
    throw new ConfigurationError(`Config file at ${file} is not valid JSON; not overwriting it. Fix or move the file, then retry.`);
  }
  const base = parsed.kind === 'ok' ? parsed.value : {};
  const analytics = isRecord(base['analytics']) ? base['analytics'] : {};
  const next = { ...base, analytics: { ...analytics, promptReduction: value } };
  const indent = parsed.kind === 'ok' ? detectIndent(parsed.raw) : 0;
  const trailing = parsed.kind === 'ok' && /\r?\n$/.test(parsed.raw) ? '\n' : '';
  await writeFileAtomic(file, JSON.stringify(next, null, indent) + trailing);
}

/** Turns reduction on (default) or off (explicit `false`) for one project; touches only `analytics.promptReduction`. */
export async function writeProjectReductionFlag(projectDir: string, on: boolean = true): Promise<void> {
  await writeFlag(projectConfigFile(projectDir), on);
}

/** Sets reduction on or off globally (off stores an explicit `false`). */
export async function writeGlobalReductionFlag(on: boolean): Promise<void> {
  await writeFlag(getCodemiePath(CONFIG_FILE), on);
}

/** Projects opted in to reduction (absolute paths); a missing list is empty, an unreadable one `unreadable`. */
export async function readOptedInProjects(): Promise<string[] | 'unreadable'> {
  let raw: string;
  try {
    raw = await fs.readFile(getCodemiePath(OPTED_IN_FILE), 'utf-8');
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? [] : 'unreadable';
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return 'unreadable';
    return value as string[];
  } catch {
    return 'unreadable';
  }
}

/** Adds one absolute project path to the opted-in list; an unreadable list is left untouched and an error thrown. */
export async function addOptedInProject(absPath: string): Promise<void> {
  if (!path.isAbsolute(absPath)) {
    throw new ConfigurationError(`Opted-in project path must be absolute: ${absPath}`);
  }
  const current = await readOptedInProjects();
  if (current === 'unreadable') {
    throw new ConfigurationError(
      `Opted-in project list at ${getCodemiePath(OPTED_IN_FILE)} is unreadable; not overwriting it. Fix or move the file, then retry.`
    );
  }
  if (current.includes(absPath)) return;
  await writeFileAtomic(getCodemiePath(OPTED_IN_FILE), JSON.stringify([...current, absPath], null, 2) + '\n');
}

/** Removes one absolute project path from the opted-in list; a missing path is a no-op, an unreadable list is left untouched and an error thrown. */
export async function removeOptedInProject(absPath: string): Promise<void> {
  const current = await readOptedInProjects();
  if (current === 'unreadable') {
    throw new ConfigurationError(
      `Opted-in project list at ${getCodemiePath(OPTED_IN_FILE)} is unreadable; not overwriting it. Fix or move the file, then retry.`
    );
  }
  if (!current.includes(absPath)) return;
  await writeFileAtomic(getCodemiePath(OPTED_IN_FILE), JSON.stringify(current.filter((entry) => entry !== absPath), null, 2) + '\n');
}
