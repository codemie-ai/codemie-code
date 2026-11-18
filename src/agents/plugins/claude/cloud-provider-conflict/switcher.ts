/**
 * Switcher for the cloud-provider settings conflict.
 *
 * After the user agreed to switch, `applySwitch` re-resolves the conflict, backs up exactly the bytes it
 * read, derives the stripped content from those same bytes and writes it atomically. If anything fails or
 * a file changed meanwhile, what was already written is restored and the error names the backup folder.
 * Setting values never leave this module: output and the manifest carry paths and key names only. Nothing
 * here prompts or exits.
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { applyEdits, modify, parse, type FormattingOptions, type JSONPath, type ParseError } from 'jsonc-parser';
import { ConfigurationError } from '@/utils/errors.js';
import { logger } from '@/utils/logger.js';
import { sanitizeDisplayText } from '@/utils/project-binding.js';
import { getCodemiePath } from '@/utils/paths.js';
import type { CloudProviderDescriptor } from './provider.js';
import {
  resolveProviderConflict,
  type ConflictLayer,
  type ConflictScope,
  type ConflictVerdict,
  type ResolveConflictInput,
} from './resolver.js';

/** Same inputs the gate resolved with. */
export type SwitchPlan = ResolveConflictInput;

export type SwitchFileKind = 'claude-json' | 'vscode-jsonc' | 'desktop-applied';

export interface SwitchedFile {
  /** Original path as the resolver reported it (a symlink path stays the link). */
  path: string;
  kind: SwitchFileKind;
}

export interface SwitchResult {
  /** The backup folder, or null when nothing needed switching and no backup was made. */
  backupDir: string | null;
  /** Every file that was backed up. */
  files: SwitchedFile[];
  /** The files whose content was rewritten (a subset of `files`; Desktop applied is backed up only). */
  changed: string[];
}

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface AtomicWriteOptions {
  /** Permission bits for the new file. */
  mode: number;
  /** When set, the write aborts if the file's mtime or size differ right before the rename. */
  expected?: FileStamp;
  /** Test seam: runs after the temp file is written and before the stat check and rename. */
  beforeRename?: (file: string) => void | Promise<void>;
}

export type AtomicWriter = (file: string, content: Buffer, options: AtomicWriteOptions) => Promise<void>;

/** Seams for tests; production uses the real filesystem, `~/.codemie/backups` and console output. */
export interface SwitchDeps {
  backupRoot?: string;
  now?: () => Date;
  randomSuffix?: () => string;
  print?: (line: string) => void;
  /** Called with each file name (manifest first) right after it was written into the backup folder. */
  afterBackupWrite?: (name: string) => void | Promise<void>;
  beforeRename?: (file: string) => void | Promise<void>;
  writeFileAtomic?: AtomicWriter;
}

/** The re-resolve found a state the switch must not act on (managed policy, or cannot be told). */
export class SwitchBlockedError extends ConfigurationError {
  constructor(
    readonly verdict: ConflictVerdict,
    detail?: string
  ) {
    super(
      verdict === 'conflict-managed'
        ? 'A managed policy sets the cloud provider, so it cannot be switched here. Nothing was changed.'
        : `The cloud provider settings changed and cannot be told apart safely${detail ? `: ${sanitizeDisplayText(detail)}` : ''}. Nothing was changed.`
    );
    this.name = 'SwitchBlockedError';
  }
}

/** The switch failed. `backupDir` is the folder to recover from, or null when no backup exists (nothing was changed). */
export class SwitchFailedError extends ConfigurationError {
  constructor(
    message: string,
    readonly backupDir: string | null
  ) {
    super(message);
    this.name = 'SwitchFailedError';
  }
}

/** A settings file was modified by someone else after it was read. */
export class SettingsFileChangedError extends ConfigurationError {
  constructor(readonly file: string) {
    super(`${sanitizeDisplayText(file)} changed while the switch was running`);
    this.name = 'SettingsFileChangedError';
  }
}

const MANIFEST_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
const VSCODE_ENV_KEY = 'claudeCode.environmentVariables';
const CLAUDE_SCOPES: readonly ConflictScope[] = ['user', 'project', 'project-local'];
const MAX_FOLDER_ATTEMPTS = 10;

interface Target {
  /** Path as the resolver reported it. */
  path: string;
  /** Resolved path behind any symlink; every read and write goes here. */
  real: string;
  kind: SwitchFileKind;
  setsFlag: boolean;
  bytes: Buffer;
  stamp: FileStamp;
  mode: number;
  /** Rewritten content, or null when the file is only backed up. */
  next: Buffer | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Same detection the VS Code connector uses, so edits match the file's own indentation and line endings. */
function detectFormattingOptions(raw: string): FormattingOptions {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = raw.match(/\r?\n([ \t]+)\S/)?.[1] ?? '  ';
  const insertSpaces = !indent.startsWith('\t');
  return { insertSpaces, tabSize: insertSpaces ? indent.length : 4, eol };
}

function parseObject(raw: string, file: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    throw new SwitchFailedError(
      `${sanitizeDisplayText(file)} cannot be parsed, so it was not changed. Nothing was changed.`,
      null
    );
  }
  return parsed;
}

/** Collects removals as JSON paths and applies them highest array index first so earlier indices stay valid. */
class Editor {
  private readonly paths: JSONPath[] = [];
  private readonly formatting: FormattingOptions;

  constructor(private readonly raw: string) {
    this.formatting = detectFormattingOptions(raw);
  }

  remove(path: JSONPath): void {
    this.paths.push(path);
  }

  apply(): string {
    const ordered = [...this.paths].sort((a, b) => {
      const ai = a[a.length - 1];
      const bi = b[b.length - 1];
      return typeof ai === 'number' && typeof bi === 'number' ? bi - ai : 0;
    });
    let text = this.raw;
    for (const path of ordered) {
      text = applyEdits(text, modify(text, path, undefined, { formattingOptions: this.formatting }));
    }
    return text;
  }
}

/** Claude Code settings file: flag-scoped keys when the layer sets the flag, Bedrock model ids always. */
function stripClaudeJson(raw: string, file: string, provider: CloudProviderDescriptor, setsFlag: boolean): string {
  const parsed = parseObject(raw, file);
  const editor = new Editor(raw);
  const env = isPlainObject(parsed.env) ? parsed.env : {};

  if (setsFlag) {
    for (const key of provider.flagScopedKeys.env) if (env[key] !== undefined) editor.remove(['env', key]);
    for (const key of provider.flagScopedKeys.topLevel) if (parsed[key] !== undefined) editor.remove([key]);
  }
  for (const key of provider.modelKeys.env) if (provider.isModelId(env[key])) editor.remove(['env', key]);
  for (const key of provider.modelKeys.topLevel) if (provider.isModelId(parsed[key])) editor.remove([key]);
  for (const key of provider.modelKeys.list) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => {
      if (provider.isModelId(item)) editor.remove([key, index]);
    });
  }
  return editor.apply();
}

/** VS Code settings: whole `{ name, value }` entries of `claudeCode.environmentVariables`, nothing else. */
function stripVscode(raw: string, file: string, provider: CloudProviderDescriptor, setsFlag: boolean): string {
  const parsed = parseObject(raw, file);
  const entries = parsed[VSCODE_ENV_KEY];
  if (!Array.isArray(entries)) return raw;
  const editor = new Editor(raw);
  entries.forEach((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.name !== 'string') return;
    const flagScoped = setsFlag && provider.flagScopedKeys.env.includes(entry.name);
    const bedrockModel = provider.modelKeys.env.includes(entry.name) && provider.isModelId(entry.value);
    if (flagScoped || bedrockModel) editor.remove([VSCODE_ENV_KEY, index]);
  });
  return editor.apply();
}

/**
 * Atomic replace: resolve the real path, write the temp file beside it (so a symlink to the settings file
 * survives and the rename stays on one filesystem), then rename. Cleans the temp file on every failure.
 */
export const writeFileAtomicDefault: AtomicWriter = async (file, content, options) => {
  const real = await realpath(file);
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, content, { mode: options.mode, flag: 'wx' });
    await chmod(tmp, options.mode);
    await options.beforeRename?.(real);
    if (options.expected) {
      const now = await stat(real);
      if (now.mtimeMs !== options.expected.mtimeMs || now.size !== options.expected.size) {
        throw new SettingsFileChangedError(file);
      }
    }
    await rename(tmp, real);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
};

/** Read once: the bytes, and the stamp and mode of the same open file. */
async function readTarget(layer: ConflictLayer, kind: SwitchFileKind): Promise<Omit<Target, 'setsFlag' | 'next'>> {
  const real = await realpath(layer.path);
  const handle = await open(real, 'r');
  try {
    const info = await handle.stat();
    const bytes = await handle.readFile();
    return { path: layer.path, real, kind, bytes, stamp: { mtimeMs: info.mtimeMs, size: info.size }, mode: info.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function kindOf(layer: ConflictLayer): SwitchFileKind | undefined {
  if (layer.scope === 'vscode') return layer.editable && layer.state === 'ok' ? 'vscode-jsonc' : undefined;
  if (CLAUDE_SCOPES.includes(layer.scope)) return layer.editable && layer.state === 'ok' ? 'claude-json' : undefined;
  // Desktop applied config is only backed up here; the connect writer removes the provider keys.
  if (layer.scope === 'desktop-applied') return layer.state === 'ok' && layer.setsFlag ? 'desktop-applied' : undefined;
  return undefined;
}

async function collectTargets(
  layers: ConflictLayer[],
  provider: CloudProviderDescriptor
): Promise<Target[]> {
  const byReal = new Map<string, Target>();
  for (const layer of layers) {
    const kind = kindOf(layer);
    if (!kind) continue;
    const existing = [...byReal.values()].find((t) => t.path === layer.path);
    if (existing) {
      existing.setsFlag ||= layer.setsFlag;
      continue;
    }
    const read = await readTarget(layer, kind);
    const known = byReal.get(read.real);
    if (known) {
      known.setsFlag ||= layer.setsFlag;
      continue;
    }
    byReal.set(read.real, { ...read, setsFlag: layer.setsFlag, next: null });
  }
  const targets = [...byReal.values()];
  for (const target of targets) {
    if (target.kind === 'desktop-applied') continue;
    const raw = target.bytes.toString('utf-8');
    const text =
      target.kind === 'vscode-jsonc'
        ? stripVscode(raw, target.path, provider, target.setsFlag)
        : stripClaudeJson(raw, target.path, provider, target.setsFlag);
    if (text !== raw) target.next = Buffer.from(text, 'utf-8');
  }
  // Files with nothing to strip need no backup either, except the Desktop file the caller will rewrite.
  return targets.filter((t) => t.next !== null || t.kind === 'desktop-applied');
}

function folderName(now: Date, suffix?: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `bedrock-switch-${stamp}${suffix ? `-${suffix}` : ''}`;
}

/** Non-recursive mkdir of a fresh folder; on EEXIST retry with a random suffix, never reuse. */
async function createBackupDir(root: string, now: Date, randomSuffix: () => string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_FOLDER_ATTEMPTS; attempt++) {
    const dir = join(root, folderName(now, attempt === 0 ? undefined : randomSuffix()));
    try {
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('could not find a free backup folder name');
}

/** Manifest first (paths and kinds only), then each copy at 0600, verified byte for byte before anything is stripped. */
async function writeBackup(dir: string, targets: Target[], provider: CloudProviderDescriptor, deps: SwitchDeps, now: Date): Promise<void> {
  const entries = targets.map((t, index) => ({
    backup: `${index + 1}-${basename(t.real)}`,
    original: t.path,
    kind: t.kind,
  }));
  const writePrivate = async (name: string, content: string | Buffer): Promise<void> => {
    const file = join(dir, name);
    await writeFile(file, content, { mode: 0o600, flag: 'wx' });
    await chmod(file, 0o600);
    await deps.afterBackupWrite?.(name);
  };
  const manifest = { version: MANIFEST_VERSION, createdAt: now.toISOString(), provider: provider.name, files: entries };
  await writePrivate(MANIFEST_NAME, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [index, target] of targets.entries()) await writePrivate(entries[index].backup, target.bytes);
  for (const [index, target] of targets.entries()) {
    const copy = await readFile(join(dir, entries[index].backup));
    if (!copy.equals(target.bytes)) throw new Error(`backup copy of ${sanitizeDisplayText(target.path)} does not match the original`);
  }
}

async function restoreWritten(written: Target[], writer: AtomicWriter): Promise<string[]> {
  const failed: string[] = [];
  for (const target of [...written].reverse()) {
    try {
      await writer(target.real, target.bytes, { mode: target.mode });
    } catch (err) {
      logger.warn(`[cloud-provider-conflict] could not restore ${target.path}: ${errorText(err)}`);
      failed.push(target.path);
    }
  }
  return failed;
}

function report(print: (line: string) => void, backupDir: string, result: SwitchedFile[], changed: string[]): void {
  const dir = sanitizeDisplayText(backupDir);
  for (const path of changed) print(`Removed the Bedrock settings from ${sanitizeDisplayText(path)}.`);
  print(`Backed up ${result.length} file(s) to ${dir}; ${MANIFEST_NAME} there lists each original path.`);
  print(`To undo, copy the files in ${dir} back to the original paths listed in ${MANIFEST_NAME}.`);
  print('The backup may contain credentials (for example AWS keys); delete the folder once you have confirmed everything works.');
  print('A managed policy, if one is set, still takes precedence over these settings.');
}

const defaultPrint = (line: string): void => {
  console.log(line);
};

/** Folder plus manifest and verified copies; a failure removes the folder again and reports that nothing changed. */
async function backupTargets(targets: Target[], provider: CloudProviderDescriptor, deps: SwitchDeps): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const randomSuffix = deps.randomSuffix ?? ((): string => randomBytes(3).toString('hex'));
  const backupRoot = deps.backupRoot ?? getCodemiePath('backups');

  let backupDir: string | undefined;
  try {
    backupDir = await createBackupDir(backupRoot, now, randomSuffix);
    await writeBackup(backupDir, targets, provider, deps, now);
    return backupDir;
  } catch (err) {
    if (backupDir) await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    throw new SwitchFailedError(`Could not back up the settings (${errorText(err)}). Nothing was changed.`, null);
  }
}

/** Writes each rewritten file; on the first failure the files already written are restored and the error names the backup. */
async function writeTargets(targets: Target[], backupDir: string, deps: SwitchDeps): Promise<Target[]> {
  const writer = deps.writeFileAtomic ?? writeFileAtomicDefault;
  const written: Target[] = [];
  for (const target of targets) {
    if (!target.next) continue;
    try {
      await writer(target.real, target.next, { mode: target.mode, expected: target.stamp, beforeRename: deps.beforeRename });
      written.push(target);
    } catch (err) {
      const failedRestore = await restoreWritten(written, writeFileAtomicDefault);
      const restoreNote =
        written.length === 0
          ? 'No other file was changed.'
          : failedRestore.length === 0
            ? `${written.length} file(s) already changed were restored.`
            : `Could not restore ${failedRestore.map(sanitizeDisplayText).join(', ')}; copy them back from the backup.`;
      throw new SwitchFailedError(
        `Switching stopped at ${sanitizeDisplayText(target.path)} (${errorText(err)}). ${restoreNote} Backup folder: ${sanitizeDisplayText(backupDir)}`,
        backupDir
      );
    }
  }
  return written;
}

export async function applySwitch(plan: SwitchPlan, deps: SwitchDeps = {}): Promise<SwitchResult> {
  const provider = plan.provider;
  const empty: SwitchResult = { backupDir: null, files: [], changed: [] };

  // Re-resolve: the state may have changed since the user was asked.
  const resolution = await resolveProviderConflict(plan);
  if (resolution.verdict === 'none') return empty;
  if (resolution.verdict !== 'conflict-editable') throw new SwitchBlockedError(resolution.verdict, resolution.unknownReason);

  let targets: Target[];
  try {
    targets = await collectTargets(resolution.layers, provider);
  } catch (err) {
    if (err instanceof SwitchFailedError) throw err;
    throw new SwitchFailedError(`Could not read the settings files (${errorText(err)}). Nothing was changed.`, null);
  }
  if (targets.length === 0) return empty;

  const backupDir = await backupTargets(targets, provider, deps);
  const written = await writeTargets(targets, backupDir, deps);

  const files = targets.map((t) => ({ path: t.path, kind: t.kind }));
  const changed = written.map((t) => t.path);
  logger.debug(`[cloud-provider-conflict] switched ${provider.name}: ${changed.length} changed, ${files.length} backed up`);
  report(deps.print ?? defaultPrint, backupDir, files, changed);
  return { backupDir, files, changed };
}
