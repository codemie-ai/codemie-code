import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  SkillListItem,
  SkillDetail,
  SkillCreateParams,
  SkillUpdateParams,
  SkillCategoryItem,
  AnyJson,
} from "codemie-sdk";
import {
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  importSkill,
  exportSkill,
  attachSkillToAssistant,
  detachSkillFromAssistant,
  getAssistantSkills,
  bulkAttachSkillToAssistants,
  getSkillAssistants,
  publishSkill,
  unpublishSkill,
  listSkillCategories,
  getSkillUsers,
  reactToSkill,
  removeSkillReactions,
} from "./services/skills.js";
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

export function createSkillsSubcommand(): Command {
  const cmd = new Command("skills").description("Manage CodeMie skills");

  cmd
    .command("list")
    .description(
      "List skills accessible to the current user\n" +
        "Examples:\n" +
        "  $ codemie sdk skills list\n" +
        "  $ codemie sdk skills list --page 2 --per-page 25\n" +
        "  $ codemie sdk skills list --scope marketplace --json",
    )
    .option("--json", "Output in JSON format")
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page (1-100)", "10")
    .option(
      "--scope <scope>",
      "Scope filter: 'marketplace', 'project', or 'project_with_marketplace'",
    )
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching skills...").start();

      try {
        const params: Record<string, unknown> = {
          page: parseInt(opts.page, 10),
          per_page: parseInt(opts.perPage, 10),
        };

        if (opts.scope) {
          params.scope = opts.scope;
        }

        const items = await listSkills(client, params);

        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("skills");
          return;
        }

        printListHeader("Skills", items.length);

        const columns: TableColumn<SkillListItem>[] = [
          { header: "ID", width: 40, getValue: (s) => chalk.cyan(s.id) },
          { header: "Name", width: 30, getValue: (s) => s.name },
          {
            header: "Project",
            width: 20,
            getValue: (s) => optional(s.project),
          },
          { header: "Visibility", width: 12, getValue: (s) => s.visibility },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list skills");
      }
    });

  cmd
    .command("get <id>")
    .description("Get detailed information about a specific skill")
    .option("--json", "Output in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching skill...").start();

      try {
        const item = await getSkill(client, id);
        spinner.stop();

        if (opts.json) {
          outputJson(item);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(item.id) },
          { label: "Name", value: item.name },
          { label: "Project", value: optional(item.project) },
          { label: "Visibility", value: item.visibility },
          { label: "Description", value: optional(item.description) },
          { label: "Creator", value: optional(item.created_by?.name) },
          { label: "Created", value: item.createdDate },
          { label: "Assistants", value: String(item.assistants_count) },
        ];

        if (item.updatedDate) {
          rows.push({ label: "Updated", value: item.updatedDate });
        }

        const detailItem = item as SkillDetail;
        if (detailItem.content) {
          rows.push({ label: "Content", value: detailItem.content });
        }

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get skill");
      }
    });

  cmd
    .command("create")
    .description(
      "Create a new skill\n" +
        "Examples:\n" +
        '  $ codemie sdk skills create --data \'{"name":"my-skill","description":"Does X","content":"# Instructions\\n...","project":"MyProject"}\'\n' +
        "  $ codemie sdk skills create --json path/to/skill.json",
    )
    .option("--data <string>", "Skill configuration as inline JSON string")
    .option("--json <path>", "Path to JSON file with skill configuration")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Creating skill...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await createSkill(client, data as SkillCreateParams);
        spinner.stop();

        printSuccess(`Skill ${chalk.cyan(result.id)} created.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "create skill");
      }
    });

  cmd
    .command("update <id>")
    .description(
      "Update an existing skill\n" +
        "Examples:\n" +
        '  $ codemie sdk skills update <id> --data \'{"description":"Updated description"}\'\n' +
        "  $ codemie sdk skills update <id> --json path/to/update.json",
    )
    .option("--data <string>", "Fields to update as inline JSON string")
    .option("--json <path>", "Path to JSON file with fields to update")
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Updating skill...").start();

      try {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await updateSkill(client, id, data as SkillUpdateParams);
        spinner.stop();

        printSuccess(`Skill ${chalk.cyan(result.id)} updated.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "update skill");
      }
    });

  cmd
    .command("delete <id>")
    .description("Permanently delete a skill")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Deleting skill...").start();

      try {
        await deleteSkill(client, id);
        spinner.stop();
        printSuccess(`Skill ${chalk.cyan(id)} deleted.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "delete skill");
      }
    });

  cmd
    .command("import <file>")
    .description(
      "Import a skill from a markdown file\n" +
        "The file must include YAML frontmatter with 'name' and 'description' fields.\n" +
        "Examples:\n" +
        "  $ codemie sdk skills import ./my-skill.md --project MyProject\n" +
        "  $ codemie sdk skills import ./my-skill.md --project MyProject --visibility project",
    )
    .requiredOption("--project <name>", "Project to import the skill into")
    .option(
      "--visibility <visibility>",
      "Visibility: 'private', 'project', or 'public'",
    )
    .option("--json", "Output imported skill as JSON")
    .action(async (file: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Importing skill...").start();

      try {
        const content = await readFile(file);
        const result = await importSkill(client, {
          file_content: content.toString("base64"),
          filename: basename(file),
          project: opts.project,
          ...(opts.visibility ? { visibility: opts.visibility } : {}),
        });
        spinner.stop();

        if (opts.json) {
          outputJson(result);
          return;
        }

        printSuccess(
          `Skill ${chalk.cyan(result.id)} imported as '${result.name}'.`,
        );
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "import skill");
      }
    });

  cmd
    .command("export <id>")
    .description("Export a skill as markdown content")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Exporting skill...").start();

      try {
        const content = await exportSkill(client, id);
        spinner.stop();
        console.log(content);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "export skill");
      }
    });

  cmd
    .command("attach <assistant-id> <skill-id>")
    .description("Attach a skill to an assistant")
    .action(async (assistantId: string, skillId: string) => {
      const client = await getSdkClient();
      const spinner = ora("Attaching skill to assistant...").start();

      try {
        await attachSkillToAssistant(client, assistantId, skillId);
        spinner.stop();
        printSuccess(
          `Skill ${chalk.cyan(skillId)} attached to assistant ${chalk.cyan(assistantId)}.`,
        );
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "attach skill");
      }
    });

  cmd
    .command("detach <assistant-id> <skill-id>")
    .description("Detach a skill from an assistant")
    .action(async (assistantId: string, skillId: string) => {
      const client = await getSdkClient();
      const spinner = ora("Detaching skill from assistant...").start();

      try {
        await detachSkillFromAssistant(client, assistantId, skillId);
        spinner.stop();
        printSuccess(
          `Skill ${chalk.cyan(skillId)} detached from assistant ${chalk.cyan(assistantId)}.`,
        );
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "detach skill");
      }
    });

  cmd
    .command("list-assistant-skills <assistant-id>")
    .description("List all skills attached to an assistant")
    .option("--json", "Output in JSON format")
    .action(async (assistantId: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching assistant skills...").start();

      try {
        const items = await getAssistantSkills(client, assistantId);
        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("skills for this assistant");
          return;
        }

        printListHeader("Assistant Skills", items.length);

        const columns: TableColumn<SkillListItem>[] = [
          { header: "ID", width: 40, getValue: (s) => chalk.cyan(s.id) },
          { header: "Name", width: 30, getValue: (s) => s.name },
          { header: "Visibility", width: 12, getValue: (s) => s.visibility },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list assistant skills");
      }
    });

  cmd
    .command("bulk-attach <skill-id>")
    .description("Attach a skill to multiple assistants at once")
    .requiredOption(
      "--assistant-ids <ids>",
      "Comma-separated list of assistant IDs",
    )
    .action(async (skillId: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Attaching skill to assistants...").start();

      try {
        const assistantIds = opts.assistantIds
          .split(",")
          .map((id: string) => id.trim());
        await bulkAttachSkillToAssistants(client, skillId, assistantIds);
        spinner.stop();
        printSuccess(
          `Skill ${chalk.cyan(skillId)} attached to ${assistantIds.length} assistant(s).`,
        );
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "bulk attach skill");
      }
    });

  cmd
    .command("get-assistants <skill-id>")
    .description("List all assistants using a skill")
    .option("--json", "Output in JSON format")
    .action(async (skillId: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching skill assistants...").start();

      try {
        const items = await getSkillAssistants(client, skillId);
        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("assistants for this skill");
          return;
        }

        printListHeader("Skill Assistants", items.length);

        const columns: TableColumn<AnyJson>[] = [
          {
            header: "ID",
            width: 40,
            getValue: (a) =>
              chalk.cyan(
                typeof a === "object" && a !== null && "id" in a
                  ? String((a as Record<string, unknown>).id)
                  : "",
              ),
          },
          {
            header: "Name",
            width: 30,
            getValue: (a) =>
              typeof a === "object" && a !== null && "name" in a
                ? String((a as Record<string, unknown>).name)
                : "",
          },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get skill assistants");
      }
    });

  cmd
    .command("publish <id>")
    .description("Publish a skill to the marketplace")
    .option(
      "--categories <categories>",
      "Comma-separated list of categories (max 3)",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Publishing skill...").start();

      try {
        const categories = opts.categories
          ? opts.categories.split(",").map((c: string) => c.trim())
          : undefined;
        await publishSkill(client, id, categories);
        spinner.stop();
        printSuccess(`Skill ${chalk.cyan(id)} published to marketplace.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "publish skill");
      }
    });

  cmd
    .command("unpublish <id>")
    .description("Unpublish a skill from the marketplace")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Unpublishing skill...").start();

      try {
        await unpublishSkill(client, id);
        spinner.stop();
        printSuccess(`Skill ${chalk.cyan(id)} unpublished from marketplace.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "unpublish skill");
      }
    });

  cmd
    .command("list-categories")
    .description("List available skill categories")
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching skill categories...").start();

      try {
        const items = await listSkillCategories(client);
        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("skill categories");
          return;
        }

        printListHeader("Skill Categories", items.length);

        const columns: TableColumn<SkillCategoryItem>[] = [
          {
            header: "Value",
            width: 36,
            getValue: (c) => chalk.cyan(c.value),
          },
          { header: "Label", width: 36, getValue: (c) => c.label },
          {
            header: "Description",
            width: 40,
            getValue: (c) => optional(c.description),
          },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "list skill categories");
      }
    });

  cmd
    .command("get-users")
    .description("Get users with access to skills")
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching skill users...").start();

      try {
        const items = await getSkillUsers(client);
        spinner.stop();

        if (opts.json) {
          outputJson(items);
          return;
        }

        if (items.length === 0) {
          printEmpty("users");
          return;
        }

        printListHeader("Skill Users", items.length);

        const columns: TableColumn<AnyJson>[] = [
          {
            header: "ID",
            width: 40,
            getValue: (u) =>
              chalk.cyan(
                typeof u === "object" && u !== null && "id" in u
                  ? String((u as Record<string, unknown>).id)
                  : "",
              ),
          },
          {
            header: "Name",
            width: 30,
            getValue: (u) =>
              typeof u === "object" && u !== null && "name" in u
                ? String((u as Record<string, unknown>).name)
                : "",
          },
          {
            header: "Username",
            width: 30,
            getValue: (u) =>
              typeof u === "object" && u !== null && "username" in u
                ? String((u as Record<string, unknown>).username)
                : "",
          },
        ];
        printTable(items, columns);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get skill users");
      }
    });

  cmd
    .command("react <id>")
    .description("React to a skill with like or dislike")
    .requiredOption(
      "--reaction <reaction>",
      "Reaction type: 'like' or 'dislike'",
    )
    .action(async (id: string, opts) => {
      const client = await getSdkClient();
      const spinner = ora("Reacting to skill...").start();

      try {
        await reactToSkill(client, id, opts.reaction as "like" | "dislike");
        spinner.stop();
        printSuccess(
          `${opts.reaction === "like" ? "Liked" : "Disliked"} skill ${chalk.cyan(id)}.`,
        );
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "react to skill");
      }
    });

  cmd
    .command("remove-reactions <id>")
    .description("Remove all reactions from a skill")
    .action(async (id: string) => {
      const client = await getSdkClient();
      const spinner = ora("Removing reactions...").start();

      try {
        await removeSkillReactions(client, id);
        spinner.stop();
        printSuccess(`Reactions removed from skill ${chalk.cyan(id)}.`);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "remove skill reactions");
      }
    });

  return cmd;
}
