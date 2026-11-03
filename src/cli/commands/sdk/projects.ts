import { Command } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ApiError, type CodeMieClient } from "codemie-sdk";
import {
  listProjects,
  getProjectDetail,
  createProject,
  updateProject,
  deleteProject,
  transferOwnership,
  assignUserToProject,
  updateUserProjectAssignment,
  removeUserFromProject,
  bulkAssignUsersToProject,
  bulkRemoveUsersFromProject,
  validateUsersFromCsv,
  importUsersFromCsv,
  type ProjectDetail,
  type ProjectListItem,
  type ProjectMember,
  type ProjectCreateRequest,
  type ProjectUpdateRequest,
  type BulkAssignmentUserItem,
  type BulkAssignmentResponse,
  type BulkAssignmentResultItem,
  type CsvImportRowResult,
} from "./services/projects.js";
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
  yesNo,
  type TableColumn,
  type DetailRow,
} from "./utils/render.js";

/** Exit code for "project not found or not accessible" (0 ok, 1 error). */
export const PROJECT_NOT_FOUND_EXIT_CODE = 2;

const MEMBER_404_NOTE =
  "A 404 cannot tell a missing project from a missing user.";

/**
 * The single not-found rule: the only caller of getProjectDetail for
 * exists/get/members, and the only place that reads the HTTP status.
 * A 404 exits with PROJECT_NOT_FOUND_EXIT_CODE; other errors are rethrown.
 */
async function readProjectDetail(
  client: CodeMieClient,
  name: string,
  spinner: Ora,
  json: boolean,
): Promise<ProjectDetail> {
  try {
    return await getProjectDetail(client, name);
  } catch (error) {
    if (error instanceof ApiError) {
      const status =
        error.statusCode ?? (error as ApiError & { status?: number }).status;
      if (status === 404) {
        spinner.stop();
        if (json) {
          console.log(JSON.stringify({ name, exists: false }));
        }
        console.error(
          chalk.red(`Project '${name}' not found or not accessible`),
        );
        process.exit(PROJECT_NOT_FOUND_EXIT_CODE);
      }
    }
    throw error;
  }
}

const memberColumns: TableColumn<ProjectMember>[] = [
  { header: "User ID", width: 40, getValue: (m) => chalk.cyan(m.user_id) },
  { header: "Admin", width: 8, getValue: (m) => yesNo(m.is_project_admin) },
  { header: "Added", width: 26, getValue: (m) => optional(m.date) },
];

function printMembers(members: ProjectMember[]): void {
  if (members.length === 0) {
    printEmpty("project members");
    return;
  }
  printListHeader("Members", members.length);
  printTable(members, memberColumns);
}

function printBulkResult(result: BulkAssignmentResponse): void {
  printSuccess(`${result.message} (${result.total} user(s))`);
  if (result.results.length === 0) return;
  const columns: TableColumn<BulkAssignmentResultItem>[] = [
    { header: "User ID", width: 40, getValue: (r) => chalk.cyan(r.user_id) },
    { header: "Action", width: 12, getValue: (r) => r.action },
    { header: "Admin", width: 8, getValue: (r) => yesNo(r.is_project_admin) },
  ];
  printTable(result.results, columns);
}

function printCsvValidation(users: CsvImportRowResult[]): void {
  if (users.length === 0) {
    printEmpty("users in CSV");
    return;
  }
  printListHeader("CSV rows", users.length);
  const columns: TableColumn<CsvImportRowResult>[] = [
    { header: "Email", width: 40, getValue: (u) => u.email },
    { header: "Role", width: 14, getValue: (u) => u.role },
    {
      header: "Error",
      width: 40,
      getValue: (u) => (u.error ? chalk.red(u.error) : chalk.dim("—")),
    },
  ];
  printTable(users, columns);
}

/**
 * Shared command body: client, spinner (stderr), action, error handling.
 */
async function run(
  text: string,
  operation: string,
  fn: (client: CodeMieClient, spinner: Ora) => Promise<void>,
): Promise<void> {
  const client = await getSdkClient();
  const spinner = ora(text).start();
  try {
    await fn(client, spinner);
  } catch (error) {
    spinner.stop();
    handleSdkError(error, operation);
  }
}

export function createProjectsSubcommand(): Command {
  const cmd = new Command("projects").description(
    "Manage CodeMie projects and project membership",
  );

  cmd
    .command("list")
    .description(
      "List projects\n" +
        "Examples:\n" +
        "  $ codemie sdk projects list\n" +
        "  $ codemie sdk projects list --search demo --sort-by created_at --sort-order desc --json",
    )
    .option("--json", "Output raw {data, pagination} as JSON")
    .option("--search <text>", "Filter by name")
    .option("--page <n>", "Page number (starts at 0)", "0")
    .option("--per-page <n>", "Results per page", "10")
    .option("--sort-by <field>", "Sort by 'name' or 'created_at'")
    .option("--sort-order <order>", "Sort order 'asc' or 'desc'")
    .action(async (opts) =>
      run("Fetching projects...", "list projects", async (client, spinner) => {
        const result = await listProjects(client, {
          page: parseInt(opts.page, 10),
          per_page: parseInt(opts.perPage, 10),
          ...(opts.search ? { search: opts.search } : {}),
          ...(opts.sortBy ? { sort_by: opts.sortBy } : {}),
          ...(opts.sortOrder ? { sort_order: opts.sortOrder } : {}),
        });
        spinner.stop();

        if (opts.json) {
          outputJson(result);
          return;
        }
        if (result.data.length === 0) {
          printEmpty("projects");
          return;
        }
        printListHeader("Projects", result.data.length);
        const columns: TableColumn<ProjectListItem>[] = [
          { header: "Name", width: 36, getValue: (p) => chalk.cyan(p.name) },
          { header: "Type", width: 12, getValue: (p) => p.project_type },
          { header: "Users", width: 8, getValue: (p) => String(p.user_count) },
          { header: "Admins", width: 8, getValue: (p) => String(p.admin_count) },
          { header: "Created", width: 26, getValue: (p) => optional(p.created_at) },
        ];
        printTable(result.data, columns);
        const { total, page, per_page } = result.pagination;
        console.log(chalk.dim(`Page ${page}, ${per_page} per page, ${total} total`));
      }),
    );

  cmd
    .command("get <name>")
    .description(
      "Get project details including members\n" +
        "Exit codes: 0 ok, 2 project not found or not accessible, 1 error (auth/server)",
    )
    .option("--json", "Output in JSON format")
    .action(async (name: string, opts) =>
      run("Fetching project...", "get project", async (client, spinner) => {
        const p = await readProjectDetail(client, name, spinner, false);
        spinner.stop();

        if (opts.json) {
          outputJson(p);
          return;
        }
        const rows: DetailRow[] = [
          { label: "Name", value: chalk.cyan(p.name) },
          { label: "Display Name", value: optional(p.display_name) },
          { label: "Description", value: optional(p.description) },
          { label: "Type", value: p.project_type },
          { label: "Created By", value: optional(p.created_by) },
          { label: "Created", value: optional(p.created_at) },
          { label: "Cost Center", value: optional(p.cost_center_name) },
          { label: "Users", value: String(p.user_count) },
          { label: "Admins", value: String(p.admin_count) },
        ];
        printDetail(rows);
        printMembers(p.members);
      }),
    );

  cmd
    .command("members <name>")
    .description(
      "List project members (a view of 'projects get')\n" +
        "Exit codes: 0 ok, 2 project not found or not accessible, 1 error (auth/server)",
    )
    .option("--json", "Output in JSON format")
    .action(async (name: string, opts) =>
      run("Fetching members...", "list project members", async (client, spinner) => {
        const p = await readProjectDetail(client, name, spinner, false);
        spinner.stop();
        if (opts.json) {
          outputJson(p.members);
          return;
        }
        printMembers(p.members);
      }),
    );

  cmd
    .command("exists <name>")
    .description(
      "Check whether a project exists and is visible to the current user\n" +
        "Exit codes: 0 = exists, 2 = project not found or not accessible, 1 = error (auth/server)",
    )
    .option("--json", 'Output {"name", "exists"} as JSON')
    .action(async (name: string, opts) =>
      run("Checking project...", "check project", async (client, spinner) => {
        await readProjectDetail(client, name, spinner, Boolean(opts.json));
        spinner.stop();
        if (opts.json) {
          console.log(JSON.stringify({ name, exists: true }));
          return;
        }
        console.log("exists");
      }),
    );

  cmd
    .command("create")
    .description(
      "Create a project and print the response as JSON\n" +
        "Examples:\n" +
        '  $ codemie sdk projects create --data \'{"name":"my-project","description":"Demo"}\'\n' +
        "  $ codemie sdk projects create --json path/to/project.json",
    )
    .option("--data <string>", "Project configuration as inline JSON string")
    .option("--json <path>", "Path to JSON file with project configuration")
    .action(async (opts) =>
      run("Creating project...", "create project", async (client, spinner) => {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await createProject(client, data as ProjectCreateRequest);
        spinner.stop();
        outputJson(result);
      }),
    );

  cmd
    .command("update <name>")
    .description(
      "Update a project and print the response as JSON\n" +
        "Examples:\n" +
        '  $ codemie sdk projects update my-project --data \'{"description":"New"}\'\n' +
        "  $ codemie sdk projects update my-project --json path/to/update.json",
    )
    .option("--data <string>", "Fields to update as inline JSON string")
    .option("--json <path>", "Path to JSON file with fields to update")
    .action(async (name: string, opts) =>
      run("Updating project...", "update project", async (client, spinner) => {
        const data = await parseDataOrJsonFile(opts.data, opts.json);
        const result = await updateProject(client, name, data as ProjectUpdateRequest);
        spinner.stop();
        outputJson(result);
      }),
    );

  cmd
    .command("delete <name>")
    .description("Permanently delete a project")
    .option("--json", "Output in JSON format")
    .action(async (name: string, opts) =>
      run("Deleting project...", "delete project", async (client, spinner) => {
        const result = await deleteProject(client, name);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printSuccess(`Project ${chalk.cyan(name)} deleted.`);
      }),
    );

  cmd
    .command("transfer-ownership <name> <userId>")
    .description("Transfer project ownership to another user")
    .option("--json", "Output in JSON format")
    .action(async (name: string, userId: string, opts) =>
      run("Transferring ownership...", "transfer project ownership", async (client, spinner) => {
        const result = await transferOwnership(client, name, userId);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printSuccess(result.message);
      }),
    );

  cmd
    .command("assign <name> <userId>")
    .description(`Assign a user to a project. ${MEMBER_404_NOTE}`)
    .option("--admin", "Assign as project admin")
    .option("--json", "Output in JSON format")
    .action(async (name: string, userId: string, opts) =>
      run("Assigning user...", "assign user to project", async (client, spinner) => {
        const result = await assignUserToProject(client, name, userId, Boolean(opts.admin));
        spinner.stop();
        if (opts.json) return outputJson(result);
        printSuccess(result.message);
      }),
    );

  cmd
    .command("update-member <name> <userId>")
    .description(`Change a member's admin role. ${MEMBER_404_NOTE}`)
    .option("--admin", "Make the user a project admin")
    .option("--no-admin", "Remove project admin role")
    .option("--json", "Output in JSON format")
    .action(async (name: string, userId: string, opts) =>
      run("Updating member...", "update project member", async (client, spinner) => {
        if (typeof opts.admin !== "boolean") {
          throw new Error("Specify --admin or --no-admin.");
        }
        const result = await updateUserProjectAssignment(client, name, userId, opts.admin);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printSuccess(result.message);
      }),
    );

  cmd
    .command("remove-member <name> <userId>")
    .description(`Remove a user from a project. ${MEMBER_404_NOTE}`)
    .option("--json", "Output in JSON format")
    .action(async (name: string, userId: string, opts) =>
      run("Removing member...", "remove project member", async (client, spinner) => {
        const result = await removeUserFromProject(client, name, userId);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printSuccess(result.message);
      }),
    );

  cmd
    .command("bulk-assign <name>")
    .description(
      "Assign many users (1-1000) from a JSON file\n" +
        'File format: [{"user_id":"<id>","is_project_admin":false}, ...]\n' +
        "Examples:\n" +
        "  $ codemie sdk projects bulk-assign my-project --file users.json",
    )
    .requiredOption("--file <path>", "JSON file with an array of {user_id, is_project_admin}")
    .option("--json", "Output in JSON format")
    .action(async (name: string, opts) =>
      run("Assigning users...", "bulk assign users", async (client, spinner) => {
        const users = JSON.parse(await readFile(opts.file, "utf-8")) as BulkAssignmentUserItem[];
        const result = await bulkAssignUsersToProject(client, name, users);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printBulkResult(result);
      }),
    );

  cmd
    .command("bulk-remove <name> <userIds...>")
    .description("Remove many users (1-100) from a project")
    .option("--json", "Output in JSON format")
    .action(async (name: string, userIds: string[], opts) =>
      run("Removing users...", "bulk remove users", async (client, spinner) => {
        const result = await bulkRemoveUsersFromProject(client, name, userIds);
        spinner.stop();
        if (opts.json) return outputJson(result);
        printBulkResult(result);
      }),
    );

  cmd
    .command("csv-validate <name> <csvPath>")
    .description("Validate a users CSV for import without applying it")
    .option("--json", "Output in JSON format")
    .action(async (name: string, csvPath: string, opts) =>
      run("Validating CSV...", "validate users CSV", async (client, spinner) => {
        const csv = await readFile(csvPath);
        const result = await validateUsersFromCsv(client, name, csv, basename(csvPath));
        spinner.stop();
        if (opts.json) return outputJson(result);
        printCsvValidation(result.users);
      }),
    );

  cmd
    .command("csv-import <name> <csvPath>")
    .description(`Import users into a project from a CSV. ${MEMBER_404_NOTE}`)
    .option("--json", "Output in JSON format")
    .action(async (name: string, csvPath: string, opts) =>
      run("Importing users...", "import users from CSV", async (client, spinner) => {
        const csv = await readFile(csvPath);
        const result = await importUsersFromCsv(client, name, csv, basename(csvPath));
        spinner.stop();
        if (opts.json) return outputJson(result);
        printBulkResult(result);
      }),
    );

  return cmd;
}
