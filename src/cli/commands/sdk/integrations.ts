import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type {
  Integration,
  IntegrationCreateParams,
  IntegrationUpdateParams,
  IntegrationTypeType,
} from "codemie-sdk";
import {
  listIntegrations,
  getIntegration,
  getIntegrationByAlias,
  createIntegration,
  updateIntegration,
  deleteIntegration,
} from "./services/integrations.js";
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
  type TableColumn,
  type DetailRow,
} from "./utils/render.js";

export function createIntegrationsSubcommand(): Command {
  const cmd = new Command("integrations").description(
    "Manage CodeMie integrations",
  );

  cmd
    .command("list")
    .description(
      "List integrations visible to the current user\n" +
        "Examples:\n" +
        "  $ codemie integrations list\n" +
        "  $ codemie integrations list --setting-type project --page 2 --per-page 25\n" +
        '  $ codemie integrations list --filters \'{"credential_type":"Jira"}\' --json',
    )
    .option("--json", "Output in JSON format")
    .option(
      "--setting-type <type>",
      "Setting type: 'user' or 'project'",
      "user",
    )
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page (1-100)", "10")
    .option("--search <value>", "Search by name or description")
    .option("--projects <name>", "Filter by project name (comma-separated)")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching integrations...").start();

      try {
        const items = await listIntegrations(client, {
          setting_type: opts.settingType,
          page: parseInt(opts.page, 10),
          per_page: parseInt(opts.perPage, 10),
          filters: {
            ...(opts.projects
              ? { project: opts.projects.trim().split(",") }
              : {}),
            ...(opts.search ? { search: opts.search } : {}),
          },
        });

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("integrations");
          return;
        }

        printListHeader("Integrations", items.length);

        const columns: TableColumn<Integration>[] = [
          { header: "ID", width: 25, getValue: (i) => chalk.cyan(i.id) },
          {
            header: "Alias",
            width: 20,
            getValue: (i) => optional(i.alias),
          },
          {
            header: "Type",
            width: 15,
            getValue: (i) => i.credential_type,
          },
          {
            header: "Project",
            width: 25,
            getValue: (i) => i.project_name,
          },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list integrations");
      }
    });

  cmd
    .command("get <id>")
    .description("Get detailed information about a specific integration by ID")
    .option("--json", "Output in JSON format")
    .option(
      "--setting-type <type>",
      "Setting type: 'user' or 'project'",
      "user",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching integration...").start();

      try {
        const item = await getIntegration(client, {
          integration_id: id,
          setting_type: opts.settingType,
        });
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Alias", value: optional(item.alias) },
          { label: "Credential Type", value: item.credential_type },
          { label: "Project Name", value: item.project_name },
          { label: "Setting Type", value: item.setting_type },
          { label: "Default", value: item.default ? "Yes" : "No" },
        ];

        if (item.date) {
          rows.push({ label: "Created", value: item.date });
        }

        if (item.update_date) {
          rows.push({ label: "Updated", value: item.update_date });
        }

        if (item.user_id) {
          rows.push({ label: "User ID", value: item.user_id });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get integration");
      }
    });

  cmd
    .command("get-by-alias <alias>")
    .description("Get integration by alias")
    .option("--json", "Output in JSON format")
    .option(
      "--setting-type <type>",
      "Setting type: 'user' or 'project'",
      "user",
    )
    .action(async (alias: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching integration...").start();

      try {
        const item = await getIntegrationByAlias(client, {
          alias,
          setting_type: opts.settingType,
        });
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Alias", value: optional(item.alias) },
          { label: "Credential Type", value: item.credential_type },
          { label: "Project Name", value: item.project_name },
          { label: "Setting Type", value: item.setting_type },
          { label: "Default", value: item.default ? "Yes" : "No" },
        ];

        if (item.date) {
          rows.push({ label: "Created", value: item.date });
        }

        if (item.update_date) {
          rows.push({ label: "Updated", value: item.update_date });
        }

        if (item.user_id) {
          rows.push({ label: "User ID", value: item.user_id });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get integration by alias");
      }
    });

  cmd
    .command("create")
    .description(
      "Create a new integration with the specified configuration\n" +
        "Examples:\n" +
        '  $ codemie integrations create --data \'{"credential_type":"Jira","project_name":"MyProject","alias":"jira-main","credential_values":[{"key":"url","value":"https://jira.example.com"},{"key":"token","value":"secret"}]}\'\n' +
        "  $ codemie integrations create --json path/to/integration.json\n",
    )
    .option(
      "--data <string>",
      "Integration configuration as inline JSON string",
    )
    .option("--json <path>", "Path to JSON file with integration configuration")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Creating integration...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await createIntegration(
          client,
          data as IntegrationCreateParams,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "create integration");
      }
    });

  cmd
    .command("update <id>")
    .description(
      "Update an existing integration's configuration\n" +
        "Examples:\n" +
        '  $ codemie integrations update int_abc123 --data \'{"alias":"jira-updated"}\'\n' +
        "  $ codemie integrations update int_abc123 --json path/to/update.json\n",
    )
    .option("--data <string>", "Fields to update as inline JSON string")
    .option("--json <path>", "Path to JSON file with fields to update")
    .option(
      "--setting-type <type>",
      "Setting type: 'user' or 'project'",
      "user",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Updating integration...").start();
      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await updateIntegration(
          client,
          id,
          opts.settingType,
          data as IntegrationUpdateParams,
        );
        spinner.stop();

        printSuccess(getResponseMessage(result));
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "update integration");
      }
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete an integration")
    .option(
      "--setting-type <type>",
      "Setting type: 'user' or 'project'",
      "user",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting integration...").start();
      try {
        await deleteIntegration(
          client,
          id,
          opts.settingType as IntegrationTypeType,
        );
        spinner.stop();
        printSuccess(`✓ Integration ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete integration");
      }
    });

  return cmd;
}
