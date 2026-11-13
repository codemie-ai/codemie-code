/**
 * Rollout family loading for Codex: linked sub-agent rollouts, parent resolution and the records of
 * a picked rollout's whole family.
 */

import { readdir } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import type { CodexRolloutRecord, CodexSessionMeta } from '../codex-message-types.js';
import { readCodexJsonlTolerant } from '../codex.storage-utils.js';
import { logger } from '../../../../utils/logger.js';
import { extractCodexSpawnLinks } from './codex-collab-links.js';

export interface LinkedSubagentRollout {
  agentId: string;
  filePath: string;
  toolUseId?: string;
  agentType?: string;
  messages: unknown[];
}

/** Child rollouts a parent's spawn/wait collaboration links to, read from the parent's day directory. */
export async function loadLinkedSubagentRollouts(
  parentFilePath: string,
  records: CodexRolloutRecord[]
): Promise<LinkedSubagentRollout[]> {
  const dayDir = dirname(parentFilePath);
  const links = extractCodexSpawnLinks(records);
  if (!links.length) {
    return [];
  }

  let files: string[];
  try {
    files = await readdir(dayDir);
  } catch {
    return [];
  }

  const out: LinkedSubagentRollout[] = [];
  for (const link of links) {
    const match = files.find((f) => f.includes(link.threadId) && f.endsWith('.jsonl'));
    if (!match) {
      continue;
    }
    const childPath = join(dayDir, match);
    try {
      const childRecords = await readCodexJsonlTolerant<CodexRolloutRecord>(childPath);
      out.push({
        agentId: link.threadId,
        filePath: childPath,
        toolUseId: link.spawnCallId,
        agentType: link.agentType,
        messages: childRecords,
      });
    } catch {
      logger.debug(`[codex-adapter] Could not read child rollout: ${childPath}`);
    }
  }
  return out;
}

/** The first line of a file, or undefined when it cannot be read. */
async function readFirstLine(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      return line;
    }
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
  return undefined;
}

/**
 * The parent rollout of a picked rollout. A sub-agent rollout names its parent thread in
 * `session_meta`; the parent file is looked up in the same day directory. Any other rollout, or a
 * parent that cannot be found, resolves to the picked rollout itself.
 */
export async function resolveParentRollout(pickedPath: string): Promise<string> {
  const first = await readFirstLine(pickedPath);
  if (!first) {
    return pickedPath;
  }
  let parentId: string | undefined;
  try {
    const meta = (JSON.parse(first) as { type?: string; payload?: CodexSessionMeta & {
      parent_thread_id?: string;
      source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } } | string;
    } });
    if (meta.type === 'session_meta') {
      const source = typeof meta.payload?.source === 'object' ? meta.payload.source : undefined;
      parentId = meta.payload?.parent_thread_id ?? source?.subagent?.thread_spawn?.parent_thread_id;
    }
  } catch {
    return pickedPath;
  }
  if (!parentId) {
    return pickedPath;
  }
  try {
    const files = await readdir(dirname(pickedPath));
    const match = files.find((f) => f.includes(parentId as string) && f.endsWith('.jsonl'));
    if (match) {
      return join(dirname(pickedPath), match);
    }
  } catch {
    // fall through to the picked rollout
  }
  logger.debug('[codex-adapter] Parent rollout not found; using the picked rollout');
  return pickedPath;
}

/**
 * Records of a picked rollout's whole family: its parent (or itself) plus the parent's direct
 * children. A resumed parent older than the run, with a fresh child picked, still yields the
 * parent's records.
 */
export async function loadRolloutFamilyRecords(
  pickedPath: string,
  pickedRecords: CodexRolloutRecord[],
  pickedSubagents: LinkedSubagentRollout[] = []
): Promise<CodexRolloutRecord[]> {
  const parentPath = await resolveParentRollout(pickedPath);
  if (parentPath === pickedPath) {
    return [...pickedRecords, ...pickedSubagents.flatMap((s) => s.messages as CodexRolloutRecord[])];
  }
  const parentRecords = await readCodexJsonlTolerant<CodexRolloutRecord>(parentPath);
  const children = await loadLinkedSubagentRollouts(parentPath, parentRecords);
  const family = [...parentRecords, ...children.flatMap((c) => c.messages as CodexRolloutRecord[])];
  // The picked child may not be linked from the parent yet
  if (!children.some((c) => c.filePath === pickedPath)) {
    family.push(...pickedRecords);
  }
  return family;
}
