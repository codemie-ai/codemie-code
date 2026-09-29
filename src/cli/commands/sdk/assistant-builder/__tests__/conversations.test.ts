import { describe, it, expect, vi } from "vitest";
import type { CodeMieClient } from "codemie-sdk";
import { extractConversationId, loadTranscripts, loadTranscriptsByIds, toTranscript } from "../conversations.js";

const history = [
  { role: "User", message: "start", thoughts: [] },
  {
    role: "Assistant",
    message: "SCOR-GITS AI attributes: AI/RUN Platforms",
    thoughts: [
      { author_type: "Tool", author_name: "Search Projects" },
      { author_type: "Tool", author_name: "Get Project Dna" },
      { author_type: "Tool", author_name: "Codemie Thoughts" },
    ],
  },
];

describe("toTranscript", () => {
  it("normalizes history and drops the reasoning pseudo-tool", () => {
    const t = toTranscript({ id: "c1", date: "2026-09-28", name: "Start" }, history);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1].tool_calls.map((c) => c.name)).toEqual(["Search Projects", "Get Project Dna"]);
  });

  it("tolerates a missing history", () => {
    expect(toTranscript({ id: "c1", date: "d", name: "n" }, undefined).turns).toEqual([]);
  });
});

describe("loadTranscripts", () => {
  it("fetches the newest conversations up to the limit", async () => {
    const conversations = {
      listByAssistantId: vi.fn().mockResolvedValue([
        { id: "old", date: "2026-09-27T10:00:00", name: "a" },
        { id: "new", date: "2026-09-28T10:00:00", name: "b" },
        { id: "mid", date: "2026-09-27T12:00:00", name: "c" },
      ]),
      get: vi.fn().mockResolvedValue({ history }),
    };
    const client = { conversations } as unknown as CodeMieClient;
    const out = await loadTranscripts(client, "asst", 2);
    expect(out.map((t) => t.id)).toEqual(["new", "mid"]);
    expect(conversations.get).toHaveBeenCalledTimes(2);
  });
});

describe("extractConversationId", () => {
  it("accepts a bare id or a chat link", () => {
    const id = "fcba3a07-4f44-4e02-9389-86cef33dab9d";
    expect(extractConversationId(id)).toBe(id);
    expect(extractConversationId(`https://codemie.lab.epam.com/chats/${id}?x=1`)).toBe(id);
    expect(extractConversationId("not a link")).toBeNull();
  });
});

describe("loadTranscriptsByIds", () => {
  it("keeps order and reports per-item failures", async () => {
    const good = "11111111-1111-1111-1111-111111111111";
    const bad = "22222222-2222-2222-2222-222222222222";
    const conversations = {
      get: vi.fn(async (id: string) => {
        if (id === bad) throw new Error("Not found");
        return { conversation_id: id, date: "2026-09-28", conversation_name: "x", history };
      }),
    };
    const client = { conversations } as unknown as CodeMieClient;
    const out = await loadTranscriptsByIds(client, [`https://host/chats/${bad}`, good, "junk"]);
    expect(out).toEqual([
      { id: bad, error: "Not found" },
      expect.objectContaining({ id: good, name: "x" }),
      { id: "junk", error: "No conversation ID found" },
    ]);
  });
});
