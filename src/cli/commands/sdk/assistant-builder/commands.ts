import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyIteration } from "./report/compare.js";
import { renderHtmlReport } from "./report/html.js";
import { buildReportSummary, formatTerminalSummary } from "./report/summary.js";
import { loadWorkspace } from "./report/workspace.js";
import { loadTranscripts, loadTranscriptsByIds, type Transcript, type TranscriptError } from "./conversations.js";
import { Command, InvalidArgumentError } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { AssistantVersion, CodeMieClient } from "codemie-sdk";
import { ConfigurationError } from "@/utils/errors.js";
import {
  chatWithAssistant,
  getAssistant,
  listAssistantVersions,
  resolveCurrentVersion,
  rollbackAssistant,
} from "../services/assistants.js";
import { getSdkClient, handleSdkError, outputJson, getResponseMessage } from "../utils/cli-utils.js";
import { printTable, printSuccess, printEmpty, printListHeader, optional, type TableColumn } from "../utils/render.js";
import { evaluateDeterministicChecks } from "./checks.js";
import { buildRunSummary, writeRunOutput } from "./output.js";
import { runScenarios, runTurn, type RunnerDeps } from "./runner.js";
import { filterScenarios, loadScenarioFile } from "./scenarios.js";
import type { HistoryEntry } from "./types.js";

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_CONCURRENCY = 3;

export function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("Must be a positive integer.");
  }
  return n;
}

export async function loadHistoryFile(path: string): Promise<HistoryEntry[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf-8"));
  } catch {
    throw new ConfigurationError(`History file is not valid JSON: ${path}`);
  }
  const valid =
    Array.isArray(raw) &&
    raw.every(
      (e) =>
        e && typeof e === "object" &&
        ((e as HistoryEntry).role === "User" || (e as HistoryEntry).role === "Assistant") &&
        typeof (e as HistoryEntry).message === "string",
    );
  if (!valid) {
    throw new ConfigurationError('History file must be an array of {"role":"User"|"Assistant","message":string}.');
  }
  return raw as HistoryEntry[];
}

function depsFor(client: CodeMieClient, assistantId: string): RunnerDeps {
  return { chat: (input) => chatWithAssistant(client, assistantId, input) };
}

async function resolveVersion(
  client: CodeMieClient,
  assistantId: string,
  requested: number | undefined,
): Promise<number | null> {
  let versions: AssistantVersion[];
  try {
    versions = await listAssistantVersions(client, assistantId);
  } catch {
    return requested ?? null;
  }
  if (requested !== undefined) {
    if (versions.length > 0 && !versions.some((v) => v.version_number === requested)) {
      throw new ConfigurationError(`Assistant ${assistantId} has no version ${requested}.`);
    }
    return requested;
  }
  return versions.length > 0 ? versions[versions.length - 1].version_number : null;
}

export function registerBuilderCommands(cmd: Command): void {
  cmd
    .command("chat <id> <message>")
    .description(
      "Send one stateless message to an assistant by ID (no local registration, history not saved)\n" +
        "Use --history for multi-turn context and --json for answer + tool calls.",
    )
    .option("--history <file>", 'JSON array of {"role":"User"|"Assistant","message":"..."}')
    .option("--assistant-version <n>", "Chat with a specific assistant version", parsePositiveInt)
    .option("--timeout <seconds>", "Per-turn timeout in seconds", parsePositiveInt, DEFAULT_TIMEOUT_SECONDS)
    .option("--json", "Output the normalized turn as JSON")
    .action(async (id: string, message: string, opts) => {
      const client = await getSdkClient();
      const spinner = opts.json ? null : ora("Waiting for assistant...").start();
      try {
        const history = opts.history ? await loadHistoryFile(opts.history) : [];
        const { turn, response } = await runTurn(depsFor(client, id), message, history, {
          timeoutMs: opts.timeout * 1000,
          concurrency: 1,
          version: opts.assistantVersion,
        });
        spinner?.stop();

        if (opts.json) {
          outputJson({ ...turn, agent_error: response.agent_error ?? null, tool_errors: response.tool_errors ?? [] });
          return;
        }
        console.log(turn.assistant);
        for (const call of turn.tool_calls) {
          console.log(chalk.dim(`  ↳ ${call.name}${call.error ? chalk.red(" (error)") : ""}`));
        }
        if (response.agent_error) {
          console.error(chalk.red(`Agent error: ${JSON.stringify(response.agent_error)}`));
        }
      } catch (error) {
        spinner?.stop();
        handleSdkError(error, "chat with assistant");
      }
    });

  cmd
    .command("test <id>")
    .description(
      "Run a scenario file against an assistant and write per-scenario results\n" +
        "Writes results/, raw/, scenarios.json, checks.json and run.json into --out.",
    )
    .requiredOption("--scenarios <file>", "Path to scenarios.json")
    .requiredOption("--out <dir>", "Output directory for this run")
    .option("--assistant-version <n>", "Test a specific assistant version", parsePositiveInt)
    .option("--concurrency <n>", "Parallel scenarios (max 8)", parsePositiveInt, DEFAULT_CONCURRENCY)
    .option("--only <ids>", "Comma-separated scenario ids to run")
    .option("--timeout <seconds>", "Per-turn timeout in seconds", parsePositiveInt, DEFAULT_TIMEOUT_SECONDS)
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Preparing test run...").start();
      try {
        const scenarioFile = await loadScenarioFile(opts.scenarios);
        const only = opts.only ? String(opts.only).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const selected = filterScenarios(scenarioFile, only);
        await getAssistant(client, id);
        const version = await resolveVersion(client, id, opts.assistantVersion);

        const startedAt = new Date();
        let done = 0;
        spinner.text = `Running 0/${selected.length} scenarios...`;
        const runs = await runScenarios(
          selected,
          depsFor(client, id),
          { timeoutMs: opts.timeout * 1000, concurrency: opts.concurrency, version: opts.assistantVersion },
          () => {
            done++;
            spinner.text = `Running ${done}/${selected.length} scenarios...`;
          },
        );
        const finishedAt = new Date();

        const checks = evaluateDeterministicChecks(selected, runs.map((r) => r.result));
        const summary = buildRunSummary(id, version, startedAt, finishedAt, runs);
        await writeRunOutput(opts.out, { scenarioFile: { scenarios: selected }, runs, checks, summary });
        spinner.stop();

        printSuccess(
          `Ran ${summary.total} scenarios against ${id}${version !== null ? ` v${version}` : ""}: ` +
            `${summary.ok} ok, ${summary.errors} error. Results in ${opts.out}`,
        );
        // A timed-out turn leaves its HTTP request open; exit explicitly so it cannot hold the process.
        process.exit(0);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "test assistant");
      }
    });

  cmd
    .command("versions <id>")
    .description("List versions of an assistant\nUse --current to print only the version number currently in effect.")
    .option("--current", "Print only the version number currently in effect")
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching versions...").start();
      try {
        if (opts.current) {
          const current = await resolveCurrentVersion(client, id);
          spinner.stop();
          if (opts.json) outputJson({ current_version: current });
          else console.log(current ?? "none");
          return;
        }
        const versions = await listAssistantVersions(client, id);
        spinner.stop();
        if (opts.json) {
          outputJson(versions);
          return;
        }
        if (versions.length === 0) {
          printEmpty("versions");
          return;
        }
        printListHeader("Assistant Versions", versions.length);
        const columns: TableColumn<AssistantVersion>[] = [
          { header: "Version", width: 9, getValue: (v) => chalk.cyan(String(v.version_number)) },
          { header: "Created", width: 26, getValue: (v) => v.created_date },
          { header: "Notes", width: 50, getValue: (v) => optional(v.change_notes) },
        ];
        printTable(versions, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list assistant versions");
      }
    });

  cmd
    .command("rollback <id> <version>")
    .description("Roll an assistant back to a previous version")
    .action(async (id: string, version: string) => {
      const client = await getSdkClient();
      const spinner = ora("Rolling back...").start();
      try {
        const result = await rollbackAssistant(client, id, parsePositiveInt(version));
        spinner.stop();
        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "roll back assistant");
      }
    });

  cmd
    .command("report <workspace>")
    .description(
      "Compare test rounds in an assistant-builder workspace and write report.html\n" +
        "into the latest iteration folder. --json prints the machine-readable summary.",
    )
    .option("--name <name>", "Assistant name shown in the report")
    .option("--json", "Print the summary as JSON")
    .action(async (workspace: string, opts) => {
      try {
        const iterations = await loadWorkspace(workspace);
        const summary = buildReportSummary(iterations);
        const latest = iterations[iterations.length - 1];
        const previous = iterations.length > 1 ? iterations[iterations.length - 2] : undefined;
        const classified = classifyIteration(latest, previous);
        const reportPath = join(latest.dir, "report.html");
        const html = renderHtmlReport({ assistantName: opts.name ?? "Assistant", summary, iterations });
        await writeFile(reportPath, html, "utf-8");

        if (opts.json) {
          outputJson({ ...summary, report_path: reportPath });
          return;
        }
        const failures = [
          ...classified.filter((c) => c.status === "regressed"),
          ...classified.filter((c) => c.verdict !== null && c.verdict !== "pass" && c.status !== "regressed"),
        ];
        console.log(formatTerminalSummary(summary, failures));
        console.log(chalk.dim(`Report: ${reportPath}`));
      } catch (error) {
        handleSdkError(error, "build assistant report");
      }
    });

  cmd
    .command("conversations [id]")
    .description(
      "Show platform conversations as normalized transcripts (read-only)\n" +
        "Either the newest conversations of assistant <id>, or specific ones via --ids (IDs or chat links).",
    )
    .option("--limit <n>", "Number of newest conversations", parsePositiveInt, 10)
    .option("--ids <values>", "Comma-separated conversation IDs or chat links")
    .option("--json", "Output in JSON format")
    .action(async (id: string | undefined, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching conversations...").start();
      try {
        let items: Array<Transcript | TranscriptError>;
        if (opts.ids) {
          items = await loadTranscriptsByIds(client, String(opts.ids).split(",").map((v) => v.trim()).filter(Boolean));
        } else if (id) {
          items = await loadTranscripts(client, id, opts.limit);
        } else {
          throw new ConfigurationError("Provide an assistant id or --ids.");
        }
        spinner.stop();
        if (opts.json) {
          outputJson(items);
          return;
        }
        const transcripts = items.filter((t): t is Transcript => "turns" in t);
        for (const failed of items.filter((t): t is TranscriptError => "error" in t)) {
          console.error(chalk.yellow(`Could not load ${failed.id}: ${failed.error}`));
        }
        if (transcripts.length === 0) {
          printEmpty("conversations");
          return;
        }
        for (const t of transcripts) {
          console.log(chalk.cyan(`\n${t.date} · ${t.name} (${t.id}) · ${t.turns.length} messages`));
          for (const turn of t.turns) {
            const tools = turn.tool_calls.length ? chalk.dim(`  [${turn.tool_calls.map((c) => c.name).join(", ")}]`) : "";
            console.log(`${chalk.bold(turn.role)}: ${turn.message.replace(/\s+/g, " ").slice(0, 200)}${tools}`);
          }
        }
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list assistant conversations");
      }
    });
}
