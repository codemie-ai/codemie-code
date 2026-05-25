import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type { DataSource, FileDataSourceCreateParams } from "codemie-sdk";
import * as datasourceService from "./services/datasources.js";
import {
  getSdkClient,
  parseDataOrJsonFile,
  outputJson,
  handleSdkError,
  getResponseMessage,
} from "./utils/cli-utils.js";
import {
  printTable,
  printDetail,
  printEmpty,
  printListHeader,
  printSuccess,
  optional,
  yesNo,
  statusColor,
  type TableColumn,
  type DetailRow,
} from "./utils/render.js";
import { DATASOURCE_TYPES } from "./utils/datasource-types.js";

export function createDatasourcesSubcommand(): Command {
  const cmd = new Command("datasources").description(
    "Manage CodeMie datasources",
  );

  cmd
    .command("list")
    .description(
      "List datasources visible to the current user\n" +
        "Examples:\n" +
        "  $ codemie datasources list\n" +
        "  $ codemie datasources list --page 2 --per-page 25\n" +
        "  $ codemie datasources list --search 'My Datasource' --project MyProject --status active --json\n" +
        "  $ codemie datasources list --datasource-types confluence,jira --sort-key update_date --sort-order desc",
    )
    .option("--json", "Output in JSON format")
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page (1-100)", "20")
    .option("--search <value>", "Search by name or description")
    .option("--projects <name>", "Filter by project name (comma-separated)")
    .option(
      "--status <status>",
      "Filter by status (completed, failed, fetching, in_progress)",
    )
    .option("--sort-key <key>", "Sort by field (date, update_date)")
    .option("--sort-order <order>", "Sort order (asc, desc)")
    .option(
      "--datasource-types <types>",
      "Filter by datasource types (comma-separated)",
    )
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching datasources...").start();

      try {
        const params: Record<string, unknown> = {
          page: parseInt(opts.page, 10),
          per_page: parseInt(opts.perPage, 10),
        };

        if (opts.search) {
          params.search = opts.search;
        }
        if (opts.projects) {
          params.projects = opts.projects.trim().split(",");
        }
        if (opts.status) {
          params.status = opts.status;
        }
        if (opts.sortKey) {
          params.sort_key = opts.sortKey;
        }
        if (opts.sortOrder) {
          params.sort_order = opts.sortOrder;
        }
        if (opts.datasourceTypes) {
          params.datasource_types = opts.datasourceTypes
            .split(",")
            .map((s: string) => s.trim());
        }

        const items = await datasourceService.listDatasources(client, params);

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("datasources");
          return;
        }

        printListHeader("Datasources", items.length);

        const columns: TableColumn<DataSource>[] = [
          { header: "ID", width: 40, getValue: (d) => chalk.cyan(d.id) },
          { header: "Name", width: 26, getValue: (d) => d.name },
          {
            header: "Project",
            width: 20,
            getValue: (d) => optional(d.project_name),
          },
          { header: "Type", width: 30, getValue: (d) => optional(d.type) },
          {
            header: "Status",
            width: 14,
            getValue: (d) => statusColor(d.status),
          },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list datasources");
      }
    });

  cmd
    .command("get <id>")
    .description("Get detailed information about a specific datasource")
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching datasource...").start();

      try {
        const item = await datasourceService.getDatasource(client, id);
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Name", value: item.name },
          { label: "Project", value: optional(item.project_name) },
          { label: "Type", value: optional(item.type) },
          { label: "Status", value: statusColor(item.status) },
          { label: "Description", value: optional(item.description) },
          { label: "Shared", value: yesNo(item.shared_with_project) },
          {
            label: "Creator",
            value: optional(item.created_by?.name),
          },
        ];

        if (item.embeddings_model) {
          rows.push({ label: "Embeddings", value: item.embeddings_model });
        }

        if (item.error_message) {
          rows.push({ label: "Error", value: chalk.red(item.error_message) });
        }

        if (item.update_date) {
          rows.push({ label: "Updated", value: item.update_date });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get datasource");
      }
    });

  const createCmd = new Command("create").description(
    "Create a new datasource (use subcommand for specific type)",
  );

  // Collector function for multiple --file flags
  function collectFiles(value: string, previous: string[]): string[] {
    return previous.concat([value]);
  }

  for (const typeConfig of DATASOURCE_TYPES) {
    const serviceKey = typeConfig.serviceKey ?? typeConfig.command;
    const serviceFnName = `create${serviceKey.charAt(0).toUpperCase() + serviceKey.slice(1)}Datasource`;

    // Special handling for file datasource
    if (typeConfig.command === "file") {
      createCmd
        .command("file")
        .description(
          `Create ${typeConfig.description}\n` +
            `Examples:\n` +
            `  $ codemie sdk datasources create file --file ./doc1.pdf --file ./doc2.docx --data '{"name":"Docs","project_name":"Team"}'\n` +
            `  $ codemie sdk datasources create file --file ./report.pdf --json path/to/metadata.json`,
        )
        .requiredOption(
          "--file <path>",
          "File path (can be specified multiple times, max 10)",
          collectFiles,
          [],
        )
        .option(
          "--data <string>",
          "Datasource metadata as inline JSON string (name, project_name, description, etc.)",
        )
        .option("--json <path>", "Path to JSON file with datasource metadata")
        .action(async (opts) => {
          const client = await getSdkClient();
          const spinner = ora("Creating file datasource...").start();

          try {
            if (!opts.file || opts.file.length === 0) {
              throw new Error("At least one --file is required");
            }

            if (opts.file.length > 10) {
              throw new Error(
                `Maximum 10 files allowed, received ${opts.file.length}`,
              );
            }

            const data = (await parseDataOrJsonFile(
              opts.data,
              opts.json,
            )) as FileDataSourceCreateParams;
            const result = await datasourceService.createFileDatasource(
              client,
              data,
              opts.file,
            );
            spinner.stop();

            printSuccess(getResponseMessage(result));
          } catch (error) {
            spinner.stop();
            handleSdkError(error, "create file datasource");
          }
        });
    } else {
      createCmd
        .command(typeConfig.command)
        .description(
          `Create ${typeConfig.description}` +
            (typeConfig.example
              ? `\nExamples:\n` +
                `  $ codemie sdk datasources create ${typeConfig.command} --data '${typeConfig.example}'\n` +
                `  $ codemie sdk datasources create ${typeConfig.command} --json path/to/config.json`
              : ""),
        )
        .option(
          "--data <string>",
          "Datasource configuration as inline JSON string",
        )
        .option(
          "--json <path>",
          "Path to JSON file with datasource configuration",
        )
        .action(async (opts) => {
          const client = await getSdkClient();
          const spinner = ora(
            `Creating ${typeConfig.command} datasource...`,
          ).start();

          try {
            const data = await parseDataOrJsonFile(opts.data, opts.json);
            const serviceFn = datasourceService[
              serviceFnName as keyof typeof datasourceService
            ] as (client: any, data: any) => Promise<unknown>;
            const result = await serviceFn(client, data);
            spinner.stop();

            printSuccess(getResponseMessage(result));
          } catch (error) {
            spinner.stop();
            handleSdkError(error, `create ${typeConfig.command} datasource`);
          }
        });
    }
  }

  cmd.addCommand(createCmd);

  const updateCmd = new Command("update").description(
    "Update an existing datasource (use subcommand for specific type)",
  );

  for (const typeConfig of DATASOURCE_TYPES) {
    const serviceKey = typeConfig.serviceKey ?? typeConfig.command;
    const serviceFnName = `update${serviceKey.charAt(0).toUpperCase() + serviceKey.slice(1)}Datasource`;

    // Special handling for file datasource
    if (typeConfig.command === "file") {
      updateCmd
        .command("file <id>")
        .description(
          `Update ${typeConfig.description}\n` +
            `Examples:\n` +
            `  $ codemie sdk datasources update file ds_123 --data '{"description":"Updated docs"}'\n` +
            `  $ codemie sdk datasources update file ds_123 --json path/to/update.json`,
        )
        .option("--data <string>", "Fields to update as inline JSON string")
        .option("--json <path>", "Path to JSON file with fields to update")
        .action(async (id: string, opts) => {
          const client = await getSdkClient();
          const spinner = ora("Updating file datasource...").start();

          try {
            const data = await parseDataOrJsonFile(opts.data, opts.json);
            const result = await datasourceService.updateFileDatasource(
              client,
              id,
              data as any,
            );
            spinner.stop();

            printSuccess(getResponseMessage(result));
          } catch (error) {
            spinner.stop();
            handleSdkError(error, "update file datasource");
          }
        });
    } else {
      updateCmd
        .command(`${typeConfig.command} <id>`)
        .description(
          `Update ${typeConfig.description}` +
            (typeConfig.example
              ? `\nExamples:\n` +
                `  $ codemie sdk datasources update ${typeConfig.command} ds_123 --data '${typeConfig.example}'\n` +
                `  $ codemie sdk datasources update ${typeConfig.command} ds_123 --json path/to/update.json`
              : ""),
        )
        .option("--data <string>", "Fields to update as inline JSON string")
        .option("--json <path>", "Path to JSON file with fields to update")
        .action(async (id: string, opts) => {
          const client = await getSdkClient();
          const spinner = ora(
            `Updating ${typeConfig.command} datasource...`,
          ).start();

          try {
            const data = await parseDataOrJsonFile(opts.data, opts.json);
            const serviceFn = datasourceService[
              serviceFnName as keyof typeof datasourceService
            ] as (client: any, id: string, data: any) => Promise<unknown>;
            const result = await serviceFn(client, id, data);
            spinner.stop();

            printSuccess(getResponseMessage(result));
          } catch (error) {
            spinner.stop();
            handleSdkError(error, `update ${typeConfig.command} datasource`);
          }
        });
    }
  }

  cmd.addCommand(updateCmd);

  cmd
    .command("delete <id>")
    .description("Permanently delete a datasource")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting datasource...").start();

      try {
        await datasourceService.deleteDatasource(client, id);
        spinner.stop();
        printSuccess(`✓ Datasource ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete datasource");
      }
    });

  return cmd;
}
