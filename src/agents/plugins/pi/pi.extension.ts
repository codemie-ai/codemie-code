/**
 * Materializes the CodeMie run-ledger extension into Pi's agent directory, and
 * reads back the ledger it produces.
 *
 * The ledger replaces post-hoc transcript attribution: instead of scanning Pi's
 * session directory afterwards and inferring which files this run wrote, the
 * extension records each transcript from inside Pi as it is opened. See
 * `extension/README.md` for why, and for the constraints the asset operates under.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { logger } from '@/utils/logger.js';
import { getCodemiePath, getDirname } from '@/utils/paths.js';
import { getPiAgentDir } from './pi.paths.js';

/** Directory name under `<piAgentDir>/extensions/` that holds the materialized asset. */
const EXTENSION_DIR_NAME = 'codemie-metrics';

/** Set to `1` to skip installation entirely and remove any previously installed copy. */
const DISABLE_ENV = 'CODEMIE_PI_EXTENSION_DISABLED';

/** Absolute ledger path, handed to the extension so it holds no layout assumptions. */
export const LEDGER_PATH_ENV = 'CODEMIE_PI_LEDGER';

export interface PiExtensionStatus {
  installed: boolean;
  path?: string;
  reason?: 'disabled' | 'source-missing' | 'selftest-failed' | 'write-failed';
}

export interface PiRunLedger {
  /** True when the extension ran at all. False means the run produced no attributable data. */
  loaded: boolean;
  /** Transcripts this run wrote, deduped, existence-filtered, in first-seen order. */
  transcripts: string[];
  /** The last transcript the run was writing — the one to correlate the session record to. */
  primaryTranscript?: string;
  /** Pi's own session id for `primaryTranscript`. */
  piSessionId?: string;
  /** The transcript's cwd, which `--session <path>` makes differ from the launch cwd. */
  cwd?: string;
  /** `/name` prompt-template invocations, which never reach the transcript. */
  commandInvocations: Record<string, number>;
  /** `/skill:name` invocations, corroborating the transcript's `<skill>` wrapper. */
  skillCommandInvocations: Record<string, number>;
}

/**
 * `~/.codemie/sessions/{sessionId}_pi-run.jsonl`, beside the metrics and conversation
 * JSONL files. The `.jsonl` suffix keeps it clear of every consumer that enumerates
 * session records, all of which filter on `.json`.
 */
export function getPiRunLedgerPath(sessionId: string): string {
  return getCodemiePath('sessions', `${sessionId}_pi-run.jsonl`);
}

function emptyLedger(): PiRunLedger {
  return { loaded: false, transcripts: [], commandInvocations: {}, skillCommandInvocations: {} };
}

/**
 * Copy the extension into Pi's agent dir, then prove it loads.
 *
 * Pi turns any extension load failure into `process.exit(1)`, so a corrupted or
 * truncated asset would kill the user's session rather than merely lose metrics.
 * The pre-flight import below is the same check Pi performs (`typeof factory ===
 * 'function'`); failing it here deletes the copy, so Pi never sees it.
 *
 * Never throws: every failure degrades to `{installed: false}`.
 */
export async function ensurePiCodeMieExtension(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  // Defaulted rather than resolved inline so the self-test failure path — the one
  // that stands between a corrupted asset and `pi` exiting 1 — is reachable in tests.
  sourceDir: string = join(getDirname(import.meta.url), 'extension')
): Promise<PiExtensionStatus> {
  const targetDir = join(getPiAgentDir(cwd), 'extensions', EXTENSION_DIR_NAME);

  if (env[DISABLE_ENV] === '1') {
    await removeExtension(targetDir);
    return { installed: false, reason: 'disabled' };
  }

  try {
    const files = await readSourceFiles(sourceDir);
    if (!files) {
      logger.debug(`[pi-extension] Source assets not found at ${sourceDir}; run ledger disabled`);
      return { installed: false, reason: 'source-missing' };
    }

    await mkdir(targetDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      const targetPath = join(targetDir, name);
      // Rewrite only on change: an untouched mtime keeps Pi's `/reload` quiet and
      // avoids churn in a directory the user may be watching.
      if (await fileMatches(targetPath, content)) continue;
      await writeFile(targetPath, content, 'utf-8');
    }

    const entryPath = join(targetDir, 'index.js');
    if (!(await exportsFactory(entryPath, files['index.js']))) {
      await removeExtension(targetDir);
      logger.warn(
        '[pi-extension] Run-ledger extension failed its load self-test and was removed. '
        + 'Pi will start normally; this run will report no tool metrics.'
      );
      return { installed: false, reason: 'selftest-failed' };
    }

    logger.debug(`[pi-extension] Run ledger installed at ${targetDir}`);
    return { installed: true, path: targetDir };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[pi-extension] Could not install the run-ledger extension: ${message}`);
    await removeExtension(targetDir);
    return { installed: false, reason: 'write-failed' };
  }
}

/** Read every asset the extension directory ships. Returns undefined when it is absent. */
async function readSourceFiles(sourceDir: string): Promise<Record<string, string> | undefined> {
  if (!existsSync(sourceDir)) return undefined;

  const files: Record<string, string> = {};
  for (const name of await readdir(sourceDir)) {
    // README.md is documentation for maintainers, not part of what Pi loads.
    if (name !== 'index.js' && name !== 'package.json') continue;
    files[name] = await readFile(join(sourceDir, name), 'utf-8');
  }
  return files['index.js'] && files['package.json'] ? files : undefined;
}

async function fileMatches(path: string, content: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf-8')) === content;
  } catch {
    return false;
  }
}

/**
 * Import the materialized copy and check it exports a factory function, matching
 * Pi's own acceptance test. The content hash busts Node's module cache so a
 * rewritten asset is re-checked rather than resolved to the previous version.
 */
async function exportsFactory(entryPath: string, content: string): Promise<boolean> {
  try {
    const cacheKey = createHash('sha1').update(content).digest('hex').slice(0, 12);
    const module = (await import(`${pathToFileURL(entryPath).href}?v=${cacheKey}`)) as {
      default?: unknown;
    };
    return typeof module.default === 'function';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[pi-extension] Self-test import failed: ${message}`);
    return false;
  }
}

async function removeExtension(targetDir: string): Promise<void> {
  try {
    await rm(targetDir, { recursive: true, force: true });
  } catch {
    // Leaving a stale copy is survivable; failing the run is not.
  }
}

/**
 * Read the ledger the extension wrote during the run.
 *
 * Malformed lines are skipped individually rather than failing the read — a
 * truncated final line after a hard kill must not discard the records before it.
 * Transcript paths are existence-filtered because `getSessionFile()` reports the
 * path Pi *plans* to write, and Pi does not create the file until the session holds
 * an assistant message.
 */
export async function readPiRunLedger(sessionId: string): Promise<PiRunLedger> {
  const ledger = emptyLedger();
  const ledgerPath = getPiRunLedgerPath(sessionId);

  let raw: string;
  try {
    raw = await readFile(ledgerPath, 'utf-8');
  } catch {
    logger.debug(`[pi-extension] No run ledger at ${ledgerPath}`);
    return ledger;
  }

  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (record.t) {
      case 'boot':
        ledger.loaded = true;
        break;

      case 'session':
      case 'shutdown': {
        // The last record wins for cwd and identity: a run that forked or switched
        // sessions ends attached to the file it was writing when it stopped.
        if (typeof record.cwd === 'string' && record.cwd) ledger.cwd = record.cwd;

        const file = record.file;
        if (typeof file !== 'string' || !file || !existsSync(file)) break;
        if (!seen.has(file)) {
          seen.add(file);
          ledger.transcripts.push(file);
        }
        ledger.primaryTranscript = file;
        ledger.piSessionId = typeof record.piSessionId === 'string' ? record.piSessionId : undefined;
        break;
      }

      case 'cmd': {
        const name = record.name;
        if (typeof name !== 'string' || !name) break;
        const target =
          record.kind === 'skill' ? ledger.skillCommandInvocations : ledger.commandInvocations;
        target[name] = (target[name] ?? 0) + 1;
        break;
      }

      default:
        break;
    }
  }

  logger.debug(
    `[pi-extension] Ledger for ${sessionId}: loaded=${ledger.loaded}, `
    + `${ledger.transcripts.length} transcript(s), cwd=${ledger.cwd ?? 'unset'}`
  );
  return ledger;
}
