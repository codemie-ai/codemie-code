import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type {
  Workflow,
  WorkflowCreateParams,
  WorkflowUpdateParams,
} from "codemie-sdk";
import {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
} from "./services/workflows.js";
import {
  getSdkClient,
  parseDataOrJsonFile,
  parseConfigInput,
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
  type TableColumn,
  type DetailRow,
} from "./utils/render.js";

export function createWorkflowsSubcommand(): Command {
  const cmd = new Command("workflows").description("Manage CodeMie workflows");

  cmd
    .command("list")
    .description(
      "List workflows visible to the current user\n" +
        "Examples:\n" +
        "  $ codemie workflows list\n" +
        "  $ codemie workflows list --page 2 --per-page 25\n" +
        "  $ codemie workflows list --search 'My Workflow' --project MyProject --json",
    )
    .option("--json", "Output in JSON format")
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page (1-100)", "10")
    .option("--search <value>", "Search by name or description")
    .option("--projects <name>", "Filter by project name (comma-separated)")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching workflows...").start();

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

        const items = await listWorkflows(client, params);

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("workflows");
          return;
        }

        printListHeader("Workflows", items.length);

        const columns: TableColumn<Workflow>[] = [
          { header: "ID", width: 40, getValue: (w) => chalk.cyan(w.id) },
          { header: "Name", width: 26, getValue: (w) => w.name },
          {
            header: "Project",
            width: 20,
            getValue: (w) => optional(w.project),
          },
          { header: "Mode", width: 14, getValue: (w) => optional(w.mode) },
          { header: "Shared", width: 8, getValue: (w) => yesNo(w.shared) },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list workflows");
      }
    });

  cmd
    .command("get <id>")
    .description("Get detailed information about a specific workflow")
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching workflow...").start();

      try {
        const item = await getWorkflow(client, id);
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Name", value: item.name },
          { label: "Project", value: optional(item.project) },
          { label: "Mode", value: optional(item.mode) },
          { label: "Description", value: optional(item.description) },
          { label: "Shared", value: yesNo(item.shared) },
          {
            label: "Creator",
            value: optional(item.created_by?.name),
          },
        ];

        if (item.update_date) {
          rows.push({ label: "Updated", value: item.update_date });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get workflow");
      }
    });

  cmd
    .command("create")
    .description(
      "Create a new workflow with the specified configuration\n" +
        "Examples:\n" +
        '  $ codemie workflows create --data \'{"name":"My Workflow","description":"Custom workflow"}\' --config workflow.yaml\n' +
        '  $ codemie workflows create --json path/to/workflow.json --config workflow.yaml\n',
    )
    .option(
      "--data <string>",
      "Workflow configuration as inline JSON string",
    )
    .option(
      "--json <path>",
      "Path to JSON file with workflow configuration",
    )
    .option(
      "--config <path>",
      "Path to workflow YAML config file",
    )
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Creating workflow...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const config = opts.config
          ? await parseConfigInput(opts.config)
          : undefined;
        const result = await createWorkflow(
          client,
          data as WorkflowCreateParams,
          config,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "create workflow");
      }
    });

  cmd
    .command("update <id>")
    .description(
      "Update an existing workflow's configuration\n" +
        "Examples:\n" +
        '  $ codemie workflows update wfl_abc123 --data \'{"name":"Updated Name"}\' --config workflow.yaml\n' +
        '  $ codemie workflows update wfl_abc123 --json path/to/update.json --config workflow.yaml\n',
    )
    .option(
      "--data <string>",
      "Fields to update as inline JSON string",
    )
    .option(
      "--json <path>",
      "Path to JSON file with fields to update",
    )
    .option(
      "--config <path>",
      "Path to workflow YAML config file",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Updating workflow...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const config = opts.config
          ? await parseConfigInput(opts.config)
          : undefined;
        const result = await updateWorkflow(
          client,
          id,
          data as WorkflowUpdateParams,
          config,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "update workflow");
      }
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete a workflow")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting workflow...").start();

      try {
        await deleteWorkflow(client, id);
        spinner.stop();
        printSuccess(`✓ Workflow ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete workflow");
      }
    });

  return cmd;
}
