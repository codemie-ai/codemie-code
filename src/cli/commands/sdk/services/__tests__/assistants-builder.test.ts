import { describe, it, expect, vi } from "vitest";
import { AssistantUpdateParamsSchema, type CodeMieClient } from "codemie-sdk";
import {
  resolveCurrentVersion,
  updateAssistant,
  chatWithAssistant,
  listAssistantVersions,
  normalizeVersions,
  rollbackAssistant,
} from "../assistants.js";

function fakeClient() {
  const assistants = {
    chat: vi.fn().mockResolvedValue({ generated: "hi" }),
    chatWithVersion: vi.fn().mockResolvedValue({ generated: "v2" }),
    listVersions: vi.fn(),
    rollbackToVersion: vi.fn().mockResolvedValue({ message: "ok" }),
  };
  return { client: { assistants } as unknown as CodeMieClient, assistants };
}

describe("chatWithAssistant", () => {
  it("sends a stateless, non-streaming request", async () => {
    const { client, assistants } = fakeClient();
    const history = [{ role: "User" as const, message: "a" }, { role: "Assistant" as const, message: "b" }];
    await chatWithAssistant(client, "id-1", { message: "next", history });
    expect(assistants.chat).toHaveBeenCalledWith("id-1", {
      text: "next",
      content_raw: "next",
      history,
      stream: false,
      save_history: false,
    });
    const params = assistants.chat.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("conversation_id");
  });

  it("routes to chatWithVersion when a version is given", async () => {
    const { client, assistants } = fakeClient();
    await chatWithAssistant(client, "id-1", { message: "x", history: [], version: 2 });
    expect(assistants.chatWithVersion).toHaveBeenCalledWith("id-1", 2, expect.objectContaining({ text: "x" }));
    expect(assistants.chat).not.toHaveBeenCalled();
  });
});

describe("normalizeVersions", () => {
  const v = { version_number: 1, created_date: "2026-09-29", system_prompt: "p", context: [] };
  it.each([
    [[v]],
    [{ data: [v] }],
    [{ versions: [v] }],
    [{ items: [v] }],
  ])("accepts %j", (shape) => {
    expect(normalizeVersions(shape)).toEqual([v]);
  });
  it("returns [] for unknown shapes", () => {
    expect(normalizeVersions({ foo: 1 })).toEqual([]);
    expect(normalizeVersions(null)).toEqual([]);
  });
});

describe("listAssistantVersions / rollbackAssistant", () => {
  it("sorts versions ascending", async () => {
    const { client, assistants } = fakeClient();
    assistants.listVersions.mockResolvedValue({ data: [{ version_number: 3 }, { version_number: 1 }] });
    const versions = await listAssistantVersions(client, "id-1");
    expect(versions.map((x) => x.version_number)).toEqual([1, 3]);
  });

  it("pages through all versions", async () => {
    const { client, assistants } = fakeClient();
    const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ version_number: from + i }));
    assistants.listVersions.mockResolvedValueOnce(page(1, 100)).mockResolvedValueOnce(page(101, 5));
    const versions = await listAssistantVersions(client, "id-1");
    expect(versions).toHaveLength(105);
    expect(assistants.listVersions).toHaveBeenNthCalledWith(1, "id-1", { page: 0, per_page: 100 });
    expect(assistants.listVersions).toHaveBeenNthCalledWith(2, "id-1", { page: 1, per_page: 100 });
  });

  it("delegates rollback", async () => {
    const { client, assistants } = fakeClient();
    await rollbackAssistant(client, "id-1", 2);
    expect(assistants.rollbackToVersion).toHaveBeenCalledWith("id-1", 2);
  });
});

describe("updateAssistant with MCP servers", () => {
  it("keeps preconfigured MCP server fields through the SDK update schema", async () => {
    const update = vi.fn().mockResolvedValue({ message: "ok" });
    const server = {
      name: "EPAM Project",
      enabled: true,
      mcp_config_id: "03e2df19-998a-4cd1-a517-d55e3b1a7e41",
      use_custom_config: true,
      tools: ["get_project_dna", "search_projects"],
      mcp_connect_url: null,
      tools_tokens_size_limit: null,
      config: { url: "https://mcp", type: null, audience: null },
    };
    const client = {
      assistants: {
        get: vi.fn().mockResolvedValue({
          id: "a1", name: "Survey", description: "d", project: "p", system_prompt: "old",
          context: [], toolkits: [], conversation_starters: [], assistant_ids: [], mcp_servers: [server],
        }),
        update,
      },
      llms: { list: vi.fn().mockResolvedValue([{ base_name: "m", default: true }]) },
    } as unknown as CodeMieClient;

    await updateAssistant(client, "a1", { system_prompt: "new" });

    const parsed = AssistantUpdateParamsSchema.parse(update.mock.calls[0][1]);
    expect(parsed.system_prompt).toBe("new");
    expect(parsed.mcp_servers[0]).toMatchObject({
      mcp_config_id: "03e2df19-998a-4cd1-a517-d55e3b1a7e41",
      use_custom_config: true,
      tools: ["get_project_dna", "search_projects"],
    });
  });
});

describe("updateAssistant integrity guard", () => {
  function clientReturning(before: Record<string, unknown>, after: Record<string, unknown>) {
    const get = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    return {
      client: {
        assistants: { get, update: vi.fn().mockResolvedValue({ message: "ok" }) },
        llms: { list: vi.fn().mockResolvedValue([{ base_name: "m", default: true }]) },
      } as unknown as CodeMieClient,
      get,
    };
  }
  const base = { id: "a1", name: "S", system_prompt: "old", toolkits: [], mcp_servers: [{ name: "M", enabled: true, tools: ["x"] }] };

  it("fails when an update that did not touch mcp_servers changed them", async () => {
    const { client } = clientReturning(base, { ...base, system_prompt: "new", mcp_servers: [{ name: "M", enabled: true, tools: null }] });
    await expect(updateAssistant(client, "a1", { system_prompt: "new" })).rejects.toThrow(/changed mcp_servers/);
  });

  it("passes when untouched fields are unchanged", async () => {
    const { client, get } = clientReturning(base, { ...base, system_prompt: "new" });
    await expect(updateAssistant(client, "a1", { system_prompt: "new" })).resolves.toEqual({ message: "ok" });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCurrentVersion", () => {
  function clientWith(prompt: string, versions: Array<{ version_number: number; system_prompt: string }>) {
    return {
      assistants: {
        get: vi.fn().mockResolvedValue({ system_prompt: prompt }),
        listVersions: vi.fn().mockResolvedValue(versions),
      },
    } as unknown as CodeMieClient;
  }

  it("picks the highest version whose prompt matches the active one (pointer-style rollback)", async () => {
    const client = clientWith("B", [
      { version_number: 1, system_prompt: "A" },
      { version_number: 2, system_prompt: "B" },
      { version_number: 3, system_prompt: "C" },
    ]);
    expect(await resolveCurrentVersion(client, "a1")).toBe(2);
  });

  it("falls back to the highest version, or null without versions", async () => {
    expect(await resolveCurrentVersion(clientWith("X", [{ version_number: 4, system_prompt: "A" }]), "a1")).toBe(4);
    expect(await resolveCurrentVersion(clientWith("X", []), "a1")).toBeNull();
  });
});
