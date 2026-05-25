import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type {
  Assistant,
  AssistantBase,
  AssistantCreateParams,
  AssistantUpdateParams,
  ToolKitDetails,
} from "codemie-sdk";
import {
  listAssistants,
  getAssistant,
  createAssistant,
  updateAssistant,
  deleteAssistant,
  getAssistantTools,
} from "./services/assistants.js";
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
  printInfo,
  optional,
  yesNo,
  type TableColumn,
  type DetailRow,
} from "./utils/render.js";

export function createAssistantsSubcommand(): Command {
  const cmd = new Command("assistants").description(
    "Manage CodeMie assistants",
  );

  cmd
    .command("list")
    .description(
      "List assistants visible to the current user\n" +
        "Examples:\n" +
        "  $ codemie assistants list\n" +
        "  $ codemie assistants list --scope marketplace --page 2 --per-page 25\n" +
        "  $ codemie assistants list --search 'Notification sender' --project MyProject --json",
    )
    .option("--json", "Output in JSON format")
    .option(
      "--scope <scope>",
      "Scope: 'visible_to_user' or 'marketplace'",
      "visible_to_user",
    )
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page (1-100)", "10")
    .option("--search <value>", "Search by name or description")
    .option("--projects <name>", "Filter by project name (comma-separated)")
    .option("--full-response", "Include all assistant properties")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching assistants...").start();

      try {
        const filters: Record<string, unknown> = {};
        if (opts.search) {
          filters.search = opts.search;
        }
        if (opts.projects) {
          filters.project = opts.projects.trim().split(",");
        }

        const items = await listAssistants(client, {
          scope: opts.scope,
          page: parseInt(opts.page, 10),
          per_page: parseInt(opts.perPage, 10),
          minimal_response: !opts.fullResponse,
          filters: Object.keys(filters).length > 0 ? filters : undefined,
        });

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("assistants");
          return;
        }

        printListHeader("Assistants", items.length);

        const columns: TableColumn<Assistant | AssistantBase>[] = [
          { header: "ID", width: 40, getValue: (a) => chalk.cyan(a.id) },
          { header: "Name", width: 28, getValue: (a) => a.name },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list assistants");
      }
    });

  cmd
    .command("get <id>")
    .description("Get detailed information about a specific assistant")
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching assistant...").start();

      try {
        const item = await getAssistant(client, id);
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Name", value: item.name },
          { label: "Project", value: optional(item.project) },
          { label: "Description", value: optional(item.description) },
          { label: "Shared", value: yesNo(item.shared) },
          { label: "Global", value: yesNo(item.is_global) },
          {
            label: "Creator",
            value: optional(item.created_by?.name ?? item.creator),
          },
        ];

        if (item.llm_model_type) {
          rows.push({ label: "Model", value: item.llm_model_type });
        }

        if (item.updated_date) {
          rows.push({ label: "Updated", value: item.updated_date });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get assistant");
      }
    });

  cmd
    .command("create")
    .description(
      "Create a new assistant with the specified configuration\n" +
        "Examples:\n" +
        '  $ codemie assistants create --data \'{"name":"My Assistant","description":"Helpful bot"}\'\n' +
        "  $ codemie assistants create --json path/to/assistant.json\n",
    )
    .option("--data <string>", "Assistant configuration as inline JSON string")
    .option("--json <path>", "Path to JSON file with assistant configuration")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Creating assistant...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await createAssistant(
          client,
          data as AssistantCreateParams,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
        if (result.assistant_id) {
          printInfo(`ID: ${result.assistant_id}`);
        }
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "create assistant");
      }
    });

  cmd
    .command("update <id>")
    .description(
      "Update an existing assistant's configuration\n" +
        "Examples:\n" +
        '  $ codemie assistants update ast_abc123 --data \'{"name":"Updated Name"}\'\n' +
        "  $ codemie assistants update ast_abc123 --json path/to/update.json\n",
    )
    .option("--data <string>", "Fields to update as inline JSON string")
    .option("--json <path>", "Path to JSON file with fields to update")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Updating assistant...").start();
      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await updateAssistant(
          client,
          id,
          data as AssistantUpdateParams,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "update assistant");
      }
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete an assistant")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting assistant...").start();
      try {
        await deleteAssistant(client, id);
        spinner.stop();
        printSuccess(`✓ Assistant ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete assistant");
      }
    });

  cmd
    .command("get-tools")
    .description(
      "List available toolkits that can be assigned to an assistant\n" +
        "Use toolkit names from this list in create/update --data toolkits field.",
    )
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching available toolkits...").start();

      try {
        const tools = await getAssistantTools(client);
        spinner.stop();

        if (opts.json) {
          outputJson(tools);
          return;
        }

        if (tools.length === 0) {
          printEmpty("toolkits");
          return;
        }

        printListHeader("Available Toolkits", tools.length);

        const columns: TableColumn<ToolKitDetails>[] = [
          {
            header: "Toolkit",
            width: 28,
            getValue: (t) => chalk.cyan(t.toolkit),
          },
          { header: "Label", width: 30, getValue: (t) => t.label },
          {
            header: "Tools",
            width: 10,
            getValue: (t) => String(t.tools.length),
          },
          {
            header: "External",
            width: 10,
            getValue: (t) => (t.is_external ? chalk.dim("yes") : "no"),
          },
        ];
        printTable(tools, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get toolkits");
      }
    });

  return cmd;
}
