import type { MetricDelta } from '../../../../core/metrics/types.js';
import { extractNamedInvocations } from '../claude-named-invocations.js';
import type { ClaudeMessage } from '../../claude-message-types.js';
import { stripPastedContentTags } from '@/agents/core/pasted-content.js';

/** Suffix of the record id that marks the lines a final-pass prompts-only delta covered. */
export const PROMPTS_RECORD_SUFFIX = ':prompts';

type PendingDelta = Omit<MetricDelta, 'syncStatus' | 'syncAttempts'>;

/**
 * Prompts and named invocations (skill/agent/command names) of this run: the lines after the
 * last previously processed message up to the end of the last group emitted now. Later lines
 * belong to a group still pending and are counted by the run that emits it; on the final pass
 * nothing emits later, so they are counted now. A line stamped before the record's cutoff
 * belongs to an earlier record. Attached to the first delta (the aggregator sums across deltas).
 */
export function collectRunPromptsAndInvocations(
  // any[]: the final-pass delta reads `gitBranch`, which is not on ClaudeMessage.
  messages: any[],
  messagesByUuid: Map<string, ClaudeMessage>,
  { sessionId, processedIds, attachedUserPrompts, lastProcessedMsgIndex, lastEmittedIndex, emittedDeltas, cutoffMs, finalPass, namedOnly }: {
    sessionId: string;
    processedIds: Set<string>;
    attachedUserPrompts: Set<string>;
    lastProcessedMsgIndex: number;
    lastEmittedIndex: number;
    emittedDeltas: boolean;
    cutoffMs?: number;
    finalPass: boolean;
    namedOnly: boolean;
  }
) {
  let promptsDelta: PendingDelta | undefined;
  const runStart = lastProcessedMsgIndex + 1;
  const trailingStart = Math.max(runStart, lastEmittedIndex + 1);
  const ownLine = (line: ClaudeMessage) => !isStampedBefore(line, cutoffMs);
  const runLines = messages.slice(runStart, trailingStart).filter(ownLine);
  const trailingLines = finalPass ? messages.slice(trailingStart).filter(ownLine) : [];
  const named = extractNamedInvocations([...runLines, ...trailingLines]);

  const prompts: Array<{ count: number; text: string }> = [];
  if (attachedUserPrompts.size === 0) {
    const runPrompts = extractUserPrompts(runLines, messagesByUuid);
    const trailingPrompts = namedOnly ? new Map<string, string>() : extractUserPrompts(
      trailingLines.filter(line => line.isMeta !== true),
      messagesByUuid
    );
    for (const [uuid, text] of trailingPrompts) {
      if (isTypedPromptText(text)) runPrompts.set(uuid, text);
    }
    for (const [uuid, text] of runPrompts) {
      prompts.push({ count: 1, text });
      attachedUserPrompts.add(uuid);
    }
  }

  if (finalPass && !namedOnly) {
    promptsDelta = markFinalPass(messages, trailingStart, { sessionId, processedIds, emittedDeltas, prompts });
  }

  return { prompts, named, promptsDelta };
}

/**
 * Marks the covered lines, so a repeated final pass or a later run never counts them again.
 */
function markFinalPass(
  messages: any[],
  trailingStart: number,
  { sessionId, processedIds, emittedDeltas, prompts }: {
    sessionId: string;
    processedIds: Set<string>;
    emittedDeltas: boolean;
    prompts: Array<{ count: number; text: string }>;
  }
): PendingDelta | undefined {
  const lastCovered = messages.slice(trailingStart).filter(line => line.uuid).at(-1);
  if (lastCovered) {
    const recordId = `${lastCovered.uuid}${PROMPTS_RECORD_SUFFIX}`;
    processedIds.add(recordId);
    if (!emittedDeltas && prompts.length > 0) {
      const lastStamped = messages.slice(trailingStart).filter(line => line.timestamp).at(-1);
      return {
        recordId,
        sessionId,
        agentSessionId: lastCovered.sessionId || '',
        timestamp: lastStamped?.timestamp || new Date().toISOString(),
        gitBranch: lastCovered.gitBranch
      };
    }
  }
  return undefined;
}

function isStampedBefore(line: ClaudeMessage, cutoffMs: number | undefined): boolean {
  if (cutoffMs === undefined || !line.timestamp) return false;
  const time = Date.parse(line.timestamp);
  return !Number.isNaN(time) && time < cutoffMs;
}

/** Not a typed prompt: Claude Code's interrupt marker, local command output and slash-command line. */
function isTypedPromptText(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    !trimmed.startsWith('[Request interrupted by user') &&
    !trimmed.startsWith('<local-command-stdout>') &&
    !trimmed.startsWith('<command-name>')
  );
}

function extractUserPrompts(lines: ClaudeMessage[], messagesByUuid: Map<string, ClaudeMessage>): Map<string, string> {
  const userPromptsMap = new Map<string, string>();
  for (const msg of lines) {
    if (
      msg.message?.role === 'user' &&
      msg.uuid &&
      !isSyntheticUserPrompt(msg, messagesByUuid)
    ) {
      let textContent = '';

      if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            textContent = block.text;
            break;
          }
        }
      } else if (typeof msg.message.content === 'string') {
        textContent = msg.message.content;
      }

      if (textContent) {
        userPromptsMap.set(msg.uuid, stripPastedContentTags(textContent));
      }
    }
  }
  return userPromptsMap;
}

function isToolResultMessage(msg: any): boolean {
  if (msg?.type !== 'user') return false;

  const content = msg.message?.content;
  if (!Array.isArray(content)) return false;

  return content.some((item: any) => item.type === 'tool_result');
}

function isSyntheticUserPrompt(msg: any, messagesByUuid: Map<string, any>): boolean {
  if (msg?.type !== 'user' || !msg.parentUuid) {
    return false;
  }

  const parent = messagesByUuid.get(msg.parentUuid);
  return isToolResultMessage(parent);
}
