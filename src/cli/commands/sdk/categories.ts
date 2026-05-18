import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import type {
  Category,
  CategoryResponse,
  CategoryCreateParams,
  CategoryUpdateParams,
} from "codemie-sdk";
import {
  getCategories,
  listCategories,
  getCategory,
  createCategory,
  updateCategory,
  deleteCategory,
} from "./services/categories.js";
import {
  getSdkClient,
  parseDataOrJsonFile,
  outputJson,
  handleSdkError,
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

export function createCategoriesSubcommand(): Command {
  const cmd = new Command("assistant-categories").description(
    "Manage CodeMie assistant categories",
  );

  cmd
    .command("list")
    .description(
      "List all assistant categories\n" +
        "Without --paginated: returns all categories (public, no admin required).\n" +
        "With --paginated: returns paginated list with assistant counts (admin required).\n" +
        "Examples:\n" +
        "  $ codemie sdk assistant-categories list\n" +
        "  $ codemie sdk assistant-categories list --paginated --page 0 --per-page 25\n" +
        "  $ codemie sdk assistant-categories list --json",
    )
    .option("--json", "Output in JSON format")
    .option("--paginated", "Use paginated endpoint with assistant counts (admin required)")
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page", "20")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching categories...").start();

      try {
        if (opts.paginated) {
          const result = await listCategories(
            client,
            parseInt(opts.page, 10),
            parseInt(opts.perPage, 10),
          );
          spinner.stop();

          if (opts.json) {
            outputJson(result);
            return;
          }

          if (result.categories.length === 0) {
            printEmpty("categories");
            return;
          }

          printListHeader("Categories", result.total);

          const columns: TableColumn<CategoryResponse>[] = [
            { header: "ID", width: 36, getValue: (c) => chalk.cyan(c.id) },
            { header: "Name", width: 28, getValue: (c) => c.name },
            {
              header: "Marketplace",
              width: 14,
              getValue: (c) => String(c.marketplaceAssistantCount),
            },
            {
              header: "Project",
              width: 10,
              getValue: (c) => String(c.projectAssistantCount),
            },
          ];
          printTable(result.categories, columns);
        } else {
          const items = await getCategories(client);
          spinner.stop();

          if (opts.json) {
            outputJson(items);
            return;
          }

          if (items.length === 0) {
            printEmpty("categories");
            return;
          }

          printListHeader("Categories", items.length);

          const columns: TableColumn<Category>[] = [
            { header: "ID", width: 36, getValue: (c) => chalk.cyan(c.id) },
            { header: "Name", width: 36, getValue: (c) => c.name },
            {
              header: "Description",
              width: 40,
              getValue: (c) => optional(c.description),
            },
          ];
          printTable(items, columns);
        }
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list categories");
      }
    });

  cmd
    .command("get <id>")
    .description(
      "Get a specific category by ID (admin required)\n" +
        "Examples:\n" +
        "  $ codemie sdk assistant-categories get <id>\n" +
        "  $ codemie sdk assistant-categories get <id> --json",
    )
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching category...").start();

      try {
        const item = await getCategory(client, id);
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Name", value: item.name },
          { label: "Description", value: optional(item.description) },
          {
            label: "Marketplace",
            value: String(item.marketplaceAssistantCount),
          },
          { label: "Project", value: String(item.projectAssistantCount) },
          { label: "Created", value: item.createdAt },
        ];

        if (item.updatedAt) {
          rows.push({ label: "Updated", value: item.updatedAt });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get category");
      }
    });

  cmd
    .command("create")
    .description(
      "Create a new assistant category (admin required)\n" +
        "Examples:\n" +
        '  $ codemie sdk assistant-categories create --data \'{"name":"DevOps","description":"DevOps tooling and automation"}\'\n' +
        "  $ codemie sdk assistant-categories create --json path/to/category.json",
    )
    .option("--data <string>", "Category data as inline JSON string")
    .option("--json <path>", "Path to JSON file with category data")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Creating category...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await createCategory(
          client,
          data as CategoryCreateParams,
        );
        spinner.stop();

        printSuccess(`Category ${chalk.cyan(result.id)} created: '${result.name}'.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "create category");
      }
    });

  cmd
    .command("update <id>")
    .description(
      "Update an existing assistant category (admin required)\n" +
        "Examples:\n" +
        '  $ codemie sdk assistant-categories update <id> --data \'{"name":"Updated Name"}\'\n' +
        "  $ codemie sdk assistant-categories update <id> --json path/to/update.json",
    )
    .option("--data <string>", "Fields to update as inline JSON string")
    .option("--json <path>", "Path to JSON file with fields to update")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Updating category...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await updateCategory(
          client,
          id,
          data as CategoryUpdateParams,
        );
        spinner.stop();

        printSuccess(`Category ${chalk.cyan(result.id)} updated.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "update category");
      }
    });

  cmd
    .command("delete <id>")
    .description(
      "Delete an assistant category (admin required).\n" +
        "Fails with 409 if any assistants are assigned to it.\n" +
        "Examples:\n" +
        "  $ codemie sdk assistant-categories delete <id>",
    )
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting category...").start();

      try {
        await deleteCategory(client, id);
        spinner.stop();
        printSuccess(`Category ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete category");
      }
    });

  return cmd;
}
