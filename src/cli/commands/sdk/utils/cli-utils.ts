import { readFile } from "node:fs/promises";
import chalk from "chalk";
import type { CodeMieClient } from "codemie-sdk";
import { ApiError } from "codemie-sdk";
import { ConfigLoader } from "@/utils/config.js";
import { getAuthenticatedClient } from "@/utils/auth.js";
import { ConfigurationError } from "@/utils/errors.js";
import { logger } from "@/utils/logger.js";
import { sanitizeLogArgs } from "@/utils/security.js";
import z, { ZodError } from "zod";

/**
 * Get an authenticated CodeMie SDK client
 */
export async function getSdkClient(): Promise<CodeMieClient> {
  const config = await ConfigLoader.load();
  return getAuthenticatedClient(config);
}

/**
 * Parse --data flag value: inline JSON string only
 */
export async function parseDataInput(
  dataFlag: string | undefined,
): Promise<unknown> {
  if (!dataFlag) {
    throw new ConfigurationError('No data provided. Use --data \'{"key":"value"}\'');
  }

  try {
    return JSON.parse(dataFlag);
  } catch {
    throw new ConfigurationError(`Invalid JSON passed to --data. Check syntax near the beginning of the string.`);
  }
}

/**
 * Parse --json flag value: path to JSON file
 */
export async function parseJsonFileInput(
  jsonFlag: string | undefined,
): Promise<unknown> {
  if (!jsonFlag) {
    throw new ConfigurationError("No JSON file provided. Use --json path/to/file.json");
  }

  const content = await readFile(jsonFlag, "utf-8");
  return JSON.parse(content);
}

/**
 * Parse data from either --data (inline JSON string) or --json (file path)
 * They are mutually exclusive
 */
export async function parseDataOrJsonFile(
  dataFlag: string | undefined,
  jsonFlag: string | undefined,
): Promise<unknown> {
  if (dataFlag && jsonFlag) {
    throw new ConfigurationError(
      "Cannot use both --data and --json. Use --data for inline JSON string or --json for JSON file path.",
    );
  }

  if (!dataFlag && !jsonFlag) {
    throw new ConfigurationError(
      'Either --data or --json is required. Use --data \'{"key":"value"}\' or --json path/to/file.json',
    );
  }

  if (dataFlag) {
    return parseDataInput(dataFlag);
  }

  return parseJsonFileInput(jsonFlag);
}

/**
 * Output data as formatted JSON
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Handle API errors with user-friendly messages and exit
 */
export function handleSdkError(error: unknown, operation: string): never {
  const msg = error instanceof Error ? error.message : String(error);
  logger.error("SDK operation failed", ...sanitizeLogArgs({ operation, error: msg }));

  if (error instanceof ApiError) {
    const status = (error as ApiError & { status?: number }).status;
    if (status === 401 || status === 403) {
      console.error(
        chalk.red(
          `❌ Authorization error: You do not have permission to ${operation}.`,
        ),
      );
      console.error(
        chalk.dim(
          '   Run "codemie setup" to re-authenticate if your session expired.',
        ),
      );
    } else if (status === 404) {
      console.error(
        chalk.red(`❌ Not found: The requested resource does not exist.`),
      );
    } else {
      console.error(chalk.red(`❌ API error: ${msg}`));
    }
  } else if (error instanceof ZodError) {
    console.error(chalk.red(`❌ Operation failed:`));
    console.error(chalk.red(z.prettifyError(error)));
  } else {
    console.error(chalk.red(`❌ ${msg}`));
  }
  process.exit(1);
}

/**
 * Read a single string property safely from an unknown API response
 */
export function getResponseMessage(response: unknown): string {
  if (response && typeof response === "object" && "message" in response) {
    return String((response as Record<string, unknown>).message);
  }
  return "Done.";
}

/**
 * Parse --config flag value: path to a YAML file
 */
export async function parseConfigInput(
  configFlag: string | undefined,
): Promise<string> {
  if (!configFlag) {
    throw new ConfigurationError(
      "No config provided. Use --config path/to/file.yaml",
    );
  }

  const content = await readFile(configFlag, "utf-8");
  return content;
}
