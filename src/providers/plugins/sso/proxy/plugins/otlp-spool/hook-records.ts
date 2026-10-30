import type { OtlpHookSpoolData } from '../otlp.plugin.js';
import { isSendableProjectName } from './session-project.js';

const SESSION_END_EVENT_TYPE = 'agent.session.end';

export interface HookGroup {
  /** Sent as `X-CodeMie-Project`; every event of `ndjson` belongs to it. */
  project: string;
  ndjson: string;
  /** Whether an event of `ndjson` is a session end. */
  containsSessionEnd: boolean;
}

export interface GroupedHookPayload {
  groups: HookGroup[];
  malformed: number;
  /** Groups not sent because their name cannot travel as a header. */
  unsendable: number;
  /** Whether a group that is not sent held a session end. */
  unsendableSessionEnd: boolean;
}

interface ParsedHookRecord {
  serialized: string;
  wireEvent: Record<string, unknown>;
}

/** The `hookEvent` wire string of a spool envelope and its parsed form; `null` for an unusable record. */
function parseHookRecord(record: string): ParsedHookRecord | null {
  try {
    const serialized = (JSON.parse(record) as OtlpHookSpoolData).hookEvent;
    const wireEvent = JSON.parse(serialized) as unknown;
    if (typeof wireEvent !== 'object' || wireEvent === null) return null;
    return { serialized, wireEvent: wireEvent as Record<string, unknown> };
  } catch {
    return null;
  }
}

const toNdjson = (lines: string[]): string => (lines.length > 0 ? `${lines.join('\n')}\n` : '');

/**
 * Splits a hook batch into one request body per project, so each request's `X-CodeMie-Project`
 * matches every event in it and no event is rewritten. `hookEvent` is already the final wire event,
 * built at hook time by the adapter, and is forwarded as is. The key is the lowercased top-level
 * `codemie_project_name`; a missing, blank or non-string name belongs to `boundProject`. Groups
 * follow first appearance, events keep file order, so an unchanged range yields byte-identical
 * groups on every retry. The header is `boundProject` when the key matches it, else the first
 * spelling seen. A `filtered` (sealed) batch is already proven to be `boundProject` and stays one
 * group. A group whose name cannot travel as a header is dropped and counted in `unsendable`.
 * A complete but unusable record is counted in `malformed` and dropped; its bytes are still
 * acknowledged with the batch so the cursor can never get stuck on it.
 */
export function groupHookRecords(
  records: string[],
  boundProject: string,
  filtered: boolean
): GroupedHookPayload {
  const boundKey = boundProject.toLowerCase();
  const groups = new Map<string, { project: string; lines: string[]; containsSessionEnd: boolean }>();
  let malformed = 0;

  for (const record of records) {
    const parsed = parseHookRecord(record);
    if (!parsed) {
      malformed += 1;
      continue;
    }
    const name = parsed.wireEvent['codemie_project_name'];
    const named = !filtered && typeof name === 'string' && name.trim().length > 0;
    const key = named ? name.toLowerCase() : boundKey;
    let group = groups.get(key);
    if (!group) {
      group = {
        project: key === boundKey ? boundProject : (name as string),
        lines: [],
        containsSessionEnd: false,
      };
      groups.set(key, group);
    }
    group.lines.push(parsed.serialized);
    if (parsed.wireEvent['type'] === SESSION_END_EVENT_TYPE) {
      group.containsSessionEnd = true;
    }
  }

  const sendable: HookGroup[] = [];
  let unsendable = 0;
  let unsendableSessionEnd = false;
  for (const { project, lines, containsSessionEnd } of groups.values()) {
    if (isSendableProjectName(project)) {
      sendable.push({ project, ndjson: toNdjson(lines), containsSessionEnd });
    } else {
      unsendable += 1;
      unsendableSessionEnd ||= containsSessionEnd;
    }
  }

  return { groups: sendable, malformed, unsendable, unsendableSessionEnd };
}
