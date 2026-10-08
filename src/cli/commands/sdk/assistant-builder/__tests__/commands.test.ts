import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerBuilderCommands } from "../commands.js";

describe("registerBuilderCommands option parsing", () => {
  it("parses --assistant-version on test even when the root program defines .version()", async () => {
    const root = new Command().name("codemie").version("0.0.0").exitOverride();
    const sdk = new Command("assistants");
    registerBuilderCommands(sdk);
    const test = sdk.commands.find((c) => c.name() === "test");
    const action = vi.fn();
    test?.action(action);
    root.addCommand(sdk);

    await root.parseAsync(
      ["assistants", "test", "abc", "--scenarios", "s.json", "--out", "o", "--assistant-version", "3"],
      { from: "user" },
    );

    expect(action).toHaveBeenCalledTimes(1);
    expect(action.mock.calls[0][1]).toMatchObject({ assistantVersion: 3 });
  });
});
