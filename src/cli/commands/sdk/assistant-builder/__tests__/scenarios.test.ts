import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseScenarioFile, loadScenarioFile, filterScenarios } from "../scenarios.js";
import { ConfigurationError } from "@/utils/errors.js";

const valid = {
  scenarios: [
    {
      id: "create-bug",
      title: "Files a bug",
      turns: ["Create a bug: login broken", "Project is ABC"],
      checks: [
        { id: "c1", text: "Asks for the project" },
        { id: "c2", text: "Creates an issue", kind: "tool_called", tool: "create_issue" },
      ],
    },
    { id: "refuse-code", title: "Refuses", turns: ["Write me python"], checks: [{ id: "c1", text: "Declines" }] },
  ],
};

describe("parseScenarioFile", () => {
  it("accepts a valid file", () => {
    expect(parseScenarioFile(valid).scenarios).toHaveLength(2);
  });

  it("rejects ids that are unsafe as file names", () => {
    const bad = { scenarios: [{ ...valid.scenarios[1], id: "../escape" }] };
    expect(() => parseScenarioFile(bad)).toThrow(ConfigurationError);
  });

  it("rejects duplicate scenario ids", () => {
    const dup = { scenarios: [valid.scenarios[1], valid.scenarios[1]] };
    expect(() => parseScenarioFile(dup)).toThrow(/Duplicate scenario id: refuse-code/);
  });

  it("rejects duplicate check ids inside a scenario", () => {
    const s = { ...valid.scenarios[1], checks: [{ id: "c1", text: "a" }, { id: "c1", text: "b" }] };
    expect(() => parseScenarioFile({ scenarios: [s] })).toThrow(/Duplicate check id c1 in scenario refuse-code/);
  });

  it("requires tool when kind is set", () => {
    const s = { ...valid.scenarios[1], checks: [{ id: "c1", text: "x", kind: "tool_called" }] };
    expect(() => parseScenarioFile({ scenarios: [s] })).toThrow(ConfigurationError);
  });

  it("rejects empty turns", () => {
    const s = { ...valid.scenarios[1], turns: [] };
    expect(() => parseScenarioFile({ scenarios: [s] })).toThrow(ConfigurationError);
  });
});

describe("loadScenarioFile", () => {
  it("reports invalid JSON as a ConfigurationError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scn-"));
    const path = join(dir, "s.json");
    await writeFile(path, "{ not json");
    await expect(loadScenarioFile(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe("filterScenarios", () => {
  it("returns all scenarios without a filter", () => {
    expect(filterScenarios(parseScenarioFile(valid))).toHaveLength(2);
  });

  it("keeps only the requested ids", () => {
    expect(filterScenarios(parseScenarioFile(valid), ["refuse-code"]).map((s) => s.id)).toEqual(["refuse-code"]);
  });

  it("rejects unknown ids", () => {
    expect(() => filterScenarios(parseScenarioFile(valid), ["nope"])).toThrow(/Unknown scenario id: nope/);
  });
});
