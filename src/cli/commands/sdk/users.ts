import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { getUserProfile, getUserData } from "./services/users.js";
import { getSdkClient, outputJson, handleSdkError } from "./utils/cli-utils.js";
import { printDetail, optional, type DetailRow } from "./utils/render.js";

export function createUsersSubcommand(): Command {
  const cmd = new Command("users").description(
    "Manage CodeMie user information",
  );

  cmd
    .command("me")
    .description("Get current user profile")
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching user profile...").start();

      try {
        const user = await getUserProfile(client);
        spinner.stop();

        if (opts.json) {
          outputJson(user);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: chalk.cyan(user.user_id) },
          { label: "Username", value: optional(user.username) },
          { label: "Name", value: optional(user.name) },
          { label: "Email", value: optional(user.email) },
          {
            label: "Admin",
            value: user.is_admin ? chalk.green("yes") : chalk.dim("no"),
          },
          {
            label: "Projects",
            value:
              user.applications?.length > 0
                ? user.applications.join(", ")
                : chalk.dim("—"),
          },
          {
            label: "Admin Projects",
            value:
              user.applications_admin?.length > 0
                ? user.applications_admin.join(", ")
                : chalk.dim("—"),
          },
        ];

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get user profile");
      }
    });

  cmd
    .command("data")
    .description("Get current user data and preferences")
    .option("--json", "Output in JSON format")
    .action(async (opts) => {
      const client = await getSdkClient();
      const spinner = ora("Fetching user data...").start();

      try {
        const data = await getUserData(client);
        spinner.stop();

        if (opts.json) {
          outputJson(data);
          return;
        }

        const rows: DetailRow[] = [
          { label: "ID", value: optional(data.id) },
          { label: "User ID", value: optional(data.user_id) },
          { label: "Created", value: optional(data.date) },
          { label: "Updated", value: optional(data.update_date) },
        ];

        printDetail(rows);
      } catch (error) {
        spinner.stop();
        handleSdkError(error, "get user data");
      }
    });

  return cmd;
}
