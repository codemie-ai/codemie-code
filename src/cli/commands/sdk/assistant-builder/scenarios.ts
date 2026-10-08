import { readFile } from "node:fs/promises";
import z from "zod";
import { ConfigurationError } from "@/utils/errors.js";
import type { Scenario, ScenarioFile } from "./types.js";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const CheckSchema = z
  .object({
    id: z.string().regex(SAFE_ID),
    text: z.string().min(1),
    kind: z.enum(["tool_called", "tool_not_called"]).optional(),
    tool: z.string().min(1).optional(),
  })
  .refine((c) => !c.kind || !!c.tool, { message: "tool is required when kind is set" });

const ScenarioSchema = z.object({
  id: z.string().regex(SAFE_ID),
  title: z.string().min(1),
  turns: z.array(z.string().min(1)).min(1),
  checks: z.array(CheckSchema).min(1),
  added_in: z.number().int().optional(),
  origin: z.string().optional(),
  source_conversation: z.string().optional(),
});

const ScenarioFileSchema = z.object({ scenarios: z.array(ScenarioSchema).min(1) });

export function parseScenarioFile(raw: unknown): ScenarioFile {
  const parsed = ScenarioFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigurationError(`Invalid scenarios file:\n${z.prettifyError(parsed.error)}`);
  }

  const scenarioIds = new Set<string>();
  for (const scenario of parsed.data.scenarios) {
    if (scenarioIds.has(scenario.id)) {
      throw new ConfigurationError(`Duplicate scenario id: ${scenario.id}`);
    }
    scenarioIds.add(scenario.id);

    const checkIds = new Set<string>();
    for (const check of scenario.checks) {
      if (checkIds.has(check.id)) {
        throw new ConfigurationError(`Duplicate check id ${check.id} in scenario ${scenario.id}`);
      }
      checkIds.add(check.id);
    }
  }

  return parsed.data;
}

export async function loadScenarioFile(path: string): Promise<ScenarioFile> {
  const content = await readFile(path, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new ConfigurationError(`Scenarios file is not valid JSON: ${path}`);
  }
  return parseScenarioFile(raw);
}

export function filterScenarios(file: ScenarioFile, only?: string[]): Scenario[] {
  if (!only || only.length === 0) return file.scenarios;
  const known = new Set(file.scenarios.map((s) => s.id));
  for (const id of only) {
    if (!known.has(id)) throw new ConfigurationError(`Unknown scenario id: ${id}`);
  }
  const wanted = new Set(only);
  return file.scenarios.filter((s) => wanted.has(s.id));
}
