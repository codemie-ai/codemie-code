import type { CodeMieClient } from "codemie-sdk";
import { thoughtsToToolCalls } from "./normalize.js";
import type { ToolCall } from "./types.js";

export interface TranscriptTurn {
  role: string;
  message: string;
  tool_calls: ToolCall[];
}

export interface Transcript {
  id: string;
  date: string;
  name: string;
  turns: TranscriptTurn[];
}

export function toTranscript(
  conversation: { id: string; date: string; name: string },
  history: unknown,
): Transcript {
  const items = Array.isArray(history) ? history : [];
  const turns = items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      role: String(item.role ?? ""),
      message: String(item.message ?? ""),
      tool_calls: thoughtsToToolCalls(item.thoughts),
    }));
  return { id: conversation.id, date: conversation.date, name: conversation.name, turns };
}

export interface TranscriptError {
  id: string;
  error: string;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractConversationId(value: string): string | null {
  return UUID.exec(value)?.[0] ?? null;
}

export async function loadTranscriptsByIds(
  client: CodeMieClient,
  idsOrLinks: string[],
): Promise<Array<Transcript | TranscriptError>> {
  const out: Array<Transcript | TranscriptError> = [];
  for (const value of idsOrLinks) {
    const id = extractConversationId(value);
    if (!id) {
      out.push({ id: value, error: "No conversation ID found" });
      continue;
    }
    try {
      const details = (await client.conversations.get(id)) as {
        date?: string;
        conversation_name?: string;
        history?: unknown;
      };
      out.push(toTranscript({ id, date: details.date ?? "", name: details.conversation_name ?? "" }, details.history));
    } catch (error) {
      out.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

export async function loadTranscripts(
  client: CodeMieClient,
  assistantId: string,
  limit: number,
): Promise<Transcript[]> {
  const conversations = await client.conversations.listByAssistantId(assistantId);
  const newest = [...conversations].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
  const transcripts: Transcript[] = [];
  for (const conversation of newest) {
    const details = await client.conversations.get(conversation.id);
    transcripts.push(toTranscript(conversation, (details as { history?: unknown }).history));
  }
  return transcripts;
}
