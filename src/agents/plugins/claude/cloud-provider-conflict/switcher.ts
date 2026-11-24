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
import { restrictToCurrentWindowsUser } from './backup-access.js';
import type { CloudProviderDescriptor } from './provider.js';
import { EDITABLE_CLAUDE_SETTINGS_SCOPES, isPlainObject, printLine, VSCODE_ENV_KEY } from './shared.js';
import {
  resolveProviderConflict,
  type ConflictLayer,
  type ConflictVerdict,
  type ResolveConflictInput,
} from './resolver.js';

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
  /** How the final rename retries a locked file (test seam; production uses the defaults of `renameReplacing`). */
  renameRetry?: RenameRetryOptions;
}

/** How `renameReplacing` retries; every field is a test seam with a production default. */
export interface RenameRetryOptions {
  /** Retries happen on Windows only; defaults to the running platform. */
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each retry; their count is the number of retries. */
  delaysMs?: readonly number[];
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
  /** Platform the backup folder is protected for; defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Limits a new backup folder to the current account on Windows; defaults to `restrictToCurrentWindowsUser`. */
  restrictBackupAccess?: (dir: string) => Promise<void>;
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

/** The backup folder or one of its copies could not be made; the switch reports it as a failed backup. */
export class BackupWriteError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'BackupWriteError';
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
const MAX_FOLDER_ATTEMPTS = 10;
/** Windows reports a file held open by antivirus, an indexer or an editor as one of these; it usually clears quickly. */
const LOCKED_FILE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** About 1.5 s in all before a locked file is reported. */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

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

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Renames `from` over `to`. On Windows a replace fails with EPERM/EBUSY/EACCES while another process holds
 * `to` open; that is retried with short pauses, and `beforeAttempt` runs before every attempt so a file that
 * changed in the meantime is never overwritten. Other platforms and other errors fail on the first attempt.
 *
 * @throws The last rename error, or whatever `beforeAttempt` throws
 */
export async function renameReplacing(
  from: string,
  to: string,
  beforeAttempt?: () => Promise<void>,
  options: RenameRetryOptions = {}
): Promise<void> {
  const delays = (options.platform ?? process.platform) === 'win32' ? (options.delaysMs ?? RENAME_RETRY_DELAYS_MS) : [];
  const doRename = options.rename ?? rename;
  const sleep = options.sleep ?? sleepMs;
  for (let attempt = 0; ; attempt++) {
    await beforeAttempt?.();
    try {
      await doRename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= delays.length || !code || !LOCKED_FILE_CODES.has(code)) throw err;
      logger.debug(`[cloud-provider-conflict] ${code} replacing ${to}; retrying in ${delays[attempt]}ms`);
      await sleep(delays[attempt]);
    }
  }
}

/**
 * Atomic replace: resolve the real path, write the temp file beside it (so a symlink to the settings file
 * survives and the rename stays on one filesystem), then rename, retrying a file Windows reports as locked.
 * Cleans the temp file on every failure.
 */
export const writeFileAtomicDefault: AtomicWriter = async (file, content, options) => {
  const real = await realpath(file);
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  const unchanged = async (): Promise<void> => {
    if (!options.expected) return;
    const now = await stat(real);
    if (now.mtimeMs !== options.expected.mtimeMs || now.size !== options.expected.size) {
      throw new SettingsFileChangedError(file);
    }
  };
  try {
    await writeFile(tmp, content, { mode: options.mode, flag: 'wx' });
    await chmod(tmp, options.mode);
    await options.beforeRename?.(real);
    await renameReplacing(tmp, real, unchanged, options.renameRetry);
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
  if (EDITABLE_CLAUDE_SETTINGS_SCOPES.includes(layer.scope)) return layer.editable && layer.state === 'ok' ? 'claude-json' : undefined;
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

/**
 * On Windows the folder's modes mean nothing, so its access is limited to the current account before any file
 * is written into it. If that fails the switch still goes ahead (the folder keeps its parent's access rules,
 * private under the user profile by default) and the user is told.
 */
async function protectBackupDir(dir: string, deps: SwitchDeps): Promise<void> {
  if ((deps.platform ?? process.platform) !== 'win32') return;
  try {
    await (deps.restrictBackupAccess ?? restrictToCurrentWindowsUser)(dir);
  } catch (err) {
    logger.notice(
      `Could not limit access to the backup folder ${sanitizeDisplayText(dir)} to your Windows account (${sanitizeDisplayText(errorText(err))}); it keeps the access rules of ${sanitizeDisplayText(dirname(dir))}.`
    );
  }
}

/** Non-recursive mkdir of a fresh folder; on EEXIST retry with a random suffix, never reuse. */
async function createBackupDir(root: string, now: Date, randomSuffix: () => string, deps: SwitchDeps): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < MAX_FOLDER_ATTEMPTS; attempt++) {
    const dir = join(root, folderName(now, attempt === 0 ? undefined : randomSuffix()));
    try {
      await mkdir(dir, { mode: 0o700 });
      await chmod(dir, 0o700);
      await protectBackupDir(dir, deps);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new BackupWriteError('could not find a free backup folder name');
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
    if (!copy.equals(target.bytes)) throw new BackupWriteError(`backup copy of ${sanitizeDisplayText(target.path)} does not match the original`);
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

/** Folder plus manifest and verified copies; a failure removes the folder again and reports that nothing changed. */
async function backupTargets(targets: Target[], provider: CloudProviderDescriptor, deps: SwitchDeps): Promise<string> {
  const now = (deps.now ?? (() => new Date()))();
  const randomSuffix = deps.randomSuffix ?? ((): string => randomBytes(3).toString('hex'));
  const backupRoot = deps.backupRoot ?? getCodemiePath('backups');

  let backupDir: string | undefined;
  try {
    backupDir = await createBackupDir(backupRoot, now, randomSuffix, deps);
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

/** The result of a switch that had nothing to do: no backup, no file changed. */
export function emptySwitchResult(): SwitchResult {
  return { backupDir: null, files: [], changed: [] };
}

/**
 * Performs the switch the user agreed to. Re-resolves first with the same input the gate asked about, so a
 * state that changed meanwhile is acted on as it is now; then backs up, strips and writes each editable file.
 *
 * @param plan - The resolve input the gate asked the user about
 * @param deps - Test seams; production passes none
 * @returns The backup folder and the files backed up and changed; an empty result when nothing needed switching
 * @throws {SwitchBlockedError} When the re-resolve finds managed policy or a state that cannot be told
 * @throws {SwitchFailedError} When reading, backing up or writing fails; `backupDir` names the folder to recover from
 */
export async function applySwitch(plan: ResolveConflictInput, deps: SwitchDeps = {}): Promise<SwitchResult> {
  const provider = plan.provider;

  // Re-resolve: the state may have changed since the user was asked.
  const resolution = await resolveProviderConflict(plan);
  if (resolution.verdict === 'none') return emptySwitchResult();
  if (resolution.verdict !== 'conflict-editable') throw new SwitchBlockedError(resolution.verdict, resolution.unknownReason);

  let targets: Target[];
  try {
    targets = await collectTargets(resolution.layers, provider);
  } catch (err) {
    if (err instanceof SwitchFailedError) throw err;
    throw new SwitchFailedError(`Could not read the settings files (${errorText(err)}). Nothing was changed.`, null);
  }
  if (targets.length === 0) return emptySwitchResult();

  const backupDir = await backupTargets(targets, provider, deps);
  const written = await writeTargets(targets, backupDir, deps);

  const files = targets.map((t) => ({ path: t.path, kind: t.kind }));
  const changed = written.map((t) => t.path);
  logger.debug(`[cloud-provider-conflict] switched ${provider.name}: ${changed.length} changed, ${files.length} backed up`);
  report(deps.print ?? printLine, backupDir, files, changed);
  return { backupDir, files, changed };
}
