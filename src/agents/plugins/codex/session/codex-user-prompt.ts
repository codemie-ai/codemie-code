/**
 * Extract the first real user prompt from Codex rollout records.
 * Skips injected AGENTS.md / environment / subagent notification blocks.
 */

interface CodexRecord {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    message?: string;
    content?: unknown;
  };
}

/** True for Codex-injected context that should not become the session title. */
export function isCodexInjectedUserText(text: string): boolean {
  const t = text.trim();
  if (!t) {
    return true;
  }
  if (t.startsWith('<environment_context>')) {
    return true;
  }
  if (t.startsWith('<permissions instructions>')) {
    return true;
  }
  if (t.startsWith('<subagent_notification>')) {
    return true;
  }
  if (t.startsWith('# AGENTS.md instructions')) {
    return true;
  }
  if (t.startsWith('<INSTRUCTIONS>')) {
    return true;
  }
  if (/^#\s*AGENTS\.md\b/i.test(t)) {
    return true;
  }
  return false;
}

/** First non-injected user prompt in rollout order. */
export function firstCodexUserText(records: readonly unknown[]): string | undefined {
  for (const raw of records) {
    const rec = raw as CodexRecord;
    if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
      const msg = rec.payload.message?.trim();
      if (msg && !isCodexInjectedUserText(msg)) {
        return msg;
      }
    }
  }

  for (const raw of records) {
    const rec = raw as CodexRecord;
    if (rec.type === 'response_item' && rec.payload?.type === 'message' && rec.payload.role === 'user') {
      const content = rec.payload.content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (const block of content) {
        if (
          block
          && typeof block === 'object'
          && (block as { type?: string }).type === 'input_text'
          && typeof (block as { text?: unknown }).text === 'string'
        ) {
          const text = (block as { text: string }).text.trim();
          if (text && !isCodexInjectedUserText(text)) {
            return text;
          }
        }
      }
    }
  }

  return undefined;
}
