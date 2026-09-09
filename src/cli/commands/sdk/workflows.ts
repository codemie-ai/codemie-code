import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import inquirer from "inquirer";
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
  runWorkflow,
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

  cmd
    .command("run <id>")
    .description("Execute a custom or shared workflow by ID or name")
    .option("-i, --input <string>", "User input / variable values for the workflow")
    .option("-f, --file <name>", "File name/path parameter for the workflow")
    .option("--no-wait", "Do not wait for workflow execution to complete")
    .option("--json", "Output execution details in JSON format")
    .action(async (id: string, opts) => {
      const client = await getSdkClient(opts.json || !opts.wait);
      const spinner = ora("Running workflow...").start();

      try {
        let targetId = id;
        if (!id.startsWith("wfl_")) {
          const workflows = await listWorkflows(client, { search: id });
          const match = workflows.find(
            (w) => w.name.toLowerCase() === id.toLowerCase() || w.id === id,
          );
          if (match) {
            targetId = match.id;
          } else if (workflows.length === 1) {
            targetId = workflows[0].id;
          } else {
            spinner.stop();
            console.error(chalk.red(`❌ Workflow with ID or name "${id}" not found.`));
            process.exit(1);
          }
        }

        let userInput: any = opts.input;
        if (opts.input) {
          try {
            userInput = JSON.parse(opts.input);
          } catch {
            // Keep as string
          }
        }

        let uploadedFileName: string | undefined;
        if (opts.file) {
          spinner.stop();
          try {
            const absolutePath = path.resolve(opts.file);
            const fileContent = await fs.readFile(absolutePath);
            const uploadSpinner = ora(`Uploading ${path.basename(opts.file)}...`).start();
            try {
              const uploadRes = await client.files.upload({
                name: path.basename(opts.file),
                content: fileContent,
                mimeType: "application/octet-stream",
              });
              uploadedFileName = uploadRes.file_url;
              uploadSpinner.succeed(chalk.green(`✓ File ${path.basename(opts.file)} uploaded successfully.`));
            } catch (uploadErr: any) {
              uploadSpinner.fail(chalk.red(`Failed to upload file: ${uploadErr.message || uploadErr}`));
              process.exit(1);
            }
          } catch {
            console.error(chalk.red(`❌ Error: File "${opts.file}" not found or could not be read.`));
            process.exit(1);
          }
          spinner.start();
        }

        const result = await runWorkflow(client, targetId, userInput, uploadedFileName, undefined);
        spinner.stop();

        let execution = result as any;
        const execId = execution.execution_id || execution.id;
        let status = execution.overall_status;

        if (!opts.wait) {
          if (opts.json) {
            outputJson(execution);
          } else {
            printSuccess(`✓ Workflow execution started successfully. (Status: ${status})`);
          }
          return;
        }

        while (status === "In Progress" || status === "Pending" || status === "Interrupted") {
          if (opts.wait && (status === "In Progress" || status === "Pending")) {
            const pollSpinner = ora(`Executing workflow (status: ${status})...`).start();
            const executionService = client.workflows.executions(targetId);

            try {
              // Poll every 3 seconds, max 15 minutes (300 attempts)
              for (let i = 0; i < 300; i++) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const updated = await executionService.get(execId);
                execution = updated;
                status = updated.overall_status;
                pollSpinner.text = `Executing workflow (status: ${status})...`;

                if (status !== "In Progress" && status !== "Pending") {
                  break;
                }
              }
              pollSpinner.stop();
            } catch {
              pollSpinner.stop();
              break;
            }
          }

          if (status === "Interrupted") {
            console.log("");
            console.log(chalk.bold.yellow("⚠ Workflow execution is Interrupted and requires your decision."));

            let interruptedText = "";
            try {
              const statesService = client.workflows.executions(targetId).states(execId);
              const states = await statesService.list();
              const interruptedState = states.find((s) => s.status === "Interrupted");
              if (interruptedState) {
                const stateOutput = await statesService.getOutput(interruptedState.id);
                interruptedText = stateOutput.output || "";
              }
            } catch {
              // Silent fallback
            }

            if (interruptedText) {
              console.log(chalk.bold.cyan("Interrupted Message:"));
              console.log(chalk.white(interruptedText));
              console.log("");
            }

            const { action } = await inquirer.prompt([
              {
                type: "list",
                name: "action",
                message: "How would you like to proceed?",
                choices: [
                  { name: "Approve & Continue", value: "approve" },
                  { name: "Edit current message", value: "edit" },
                  { name: "Abort workflow", value: "abort" },
                ]
              }
            ]);

            if (action === "approve") {
              const resumeSpinner = ora("Resuming workflow...").start();
              try {
                await client.workflows.executions(targetId).resume(execId);
                status = 'In Progress';
                resumeSpinner.succeed(chalk.green("✓ Workflow resumed."));
              } catch (error) {
                resumeSpinner.fail(chalk.red("Failed to resume workflow."));
                handleSdkError(error, "resume workflow");
                break;
              }
            } else if (action === "edit") {
              const { editedMessage } = await inquirer.prompt([
                {
                  type: "input",
                  name: "editedMessage",
                  message: "Enter your edited message:",
                  default: interruptedText
                }
              ]);

              const resumeSpinner = ora("Resuming workflow with edited message...").start();
              try {
                await (client.workflows as any).api.put(
                  `/v1/workflows/${targetId}/executions/${execId}/resume`,
                  { user_input: editedMessage }
                );
                status = 'In Progress';
                resumeSpinner.succeed(chalk.green("✓ Workflow resumed with edited message."));
              } catch (error) {
                resumeSpinner.fail(chalk.red("Failed to resume workflow."));
                handleSdkError(error, "resume workflow");
                break;
              }
            } else if (action === "abort") {
              const abortSpinner = ora("Aborting workflow...").start();
              try {
                await client.workflows.executions(targetId).abort(execId);
                abortSpinner.succeed(chalk.green("✓ Workflow aborted successfully."));
                status = "Aborted";
              } catch (error) {
                abortSpinner.fail(chalk.red("Failed to abort workflow."));
                handleSdkError(error, "abort workflow");
                break;
              }
            }
          }
        }

        if (opts.json) {
          outputJson(execution);
          return;
        }

        if (status === "Succeeded") {
          try {
            const statesService = client.workflows.executions(targetId).states(execId);
            const states = await statesService.list();
            const finalState = states.find((s) => s.name === "result_finalizer_node") ||
                               states.filter((s) => s.completed_at).sort((a, b) =>
                                 new Date(a.completed_at!).getTime() - new Date(b.completed_at!).getTime()
                               ).pop();

            if (finalState) {
              const stateOutput = await statesService.getOutput(finalState.id);
              if (stateOutput && stateOutput.output) {
                console.log(stateOutput.output);
                return;
              }
            }
          } catch {
            // Silent fallback to standard output if state output fetch fails
          }
          printSuccess("✓ Workflow completed successfully.");
        } else if (status === "Failed") {
          console.error(chalk.red("❌ Workflow execution failed."));
        } else {
          printSuccess(`✓ Workflow execution ended with status: ${status}`);
          console.log("");
          outputJson(execution);
        }
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "run workflow");
      }
    });

  return cmd;
}
