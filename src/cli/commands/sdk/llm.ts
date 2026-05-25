import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { LLMModel } from "codemie-sdk";
import { listLlmModels, listEmbeddingModels } from "./services/llm.js";
import {
  getSdkClient,
  outputJson,
  handleSdkError,
} from "./utils/cli-utils.js";
import {
  printTable,
  printListHeader,
  printEmpty,
  yesNo,
  optional,
  type TableColumn,
} from "./utils/render.js";

const LLM_COLUMNS: TableColumn<LLMModel>[] = [
  { header: "Base Name", width: 36, getValue: (m) => chalk.cyan(m.base_name) },
  { header: "Label", width: 36, getValue: (m) => optional(m.label) },
  { header: "Provider", width: 18, getValue: (m) => optional(m.provider) },
  { header: "Default", width: 10, getValue: (m) => yesNo(m.default) },
  { header: "Enabled", width: 10, getValue: (m) => yesNo(m.enabled) },
];

export function createLlmModelsSubcommand(): Command {
  const cmd = new Command("llm").description(
    "List available LLM models",
  );

  cmd
    .command("list")
    .description("List available LLM models")
    .option("--embeddings", "List embedding models instead of chat models")
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const label = opts.embeddings ? "embedding models" : "LLM models";
      const spinner = ora(`Fetching ${label}...`).start();

      try {
        const items = opts.embeddings
          ? await listEmbeddingModels(client)
          : await listLlmModels(client);

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty(label);
          return;
        }

        printListHeader(
          opts.embeddings ? "Embedding Models" : "LLM Models",
          items.length,
        );
        printTable(items, LLM_COLUMNS);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, `list ${label}`);
      }
    });

  return cmd;
}
