import chalk from "chalk";
import Table from "cli-table3";

export interface TableColumn<T> {
  header: string;
  width: number;
  getValue: (item: T) => string;
}

/**
 * Generic table renderer for list views
 *
 * @example
 * ```ts
 * const columns: TableColumn<Assistant>[] = [
 *   { header: "ID", width: 40, getValue: (a) => chalk.cyan(a.id) },
 *   { header: "Name", width: 28, getValue: (a) => a.name },
 * ];
 * printTable(assistants, columns);
 * ```
 */
export function printTable<T>(items: T[], columns: TableColumn<T>[]): void {
  const table = new Table({
    style: {
      head: columns.map(() => "white"),
    },
    head: columns.map((col) => chalk.bold(col.header)),
    colWidths: columns.map((col) => col.width),
    wordWrap: true,
  });

  for (const item of items) {
    table.push(columns.map((col) => col.getValue(item)));
  }

  console.log(table.toString());
}

export interface DetailRow {
  label: string;
  value: string;
}

/**
 * Generic detail renderer for entity detail views
 *
 * @example
 * ```ts
 * const rows: DetailRow[] = [
 *   { label: "ID", value: chalk.cyan(assistant.id) },
 *   { label: "Name", value: assistant.name },
 * ];
 * printDetail(rows);
 * ```
 */
export function printDetail(
  rows: DetailRow[],
  options: { labelWidth?: number; valueWidth?: number } = {},
): void {
  const { labelWidth = 18, valueWidth = 60 } = options;

  const table = new Table({
    colWidths: [labelWidth, valueWidth],
    wordWrap: true,
  });

  for (const row of rows) {
    table.push([chalk.bold(row.label), row.value]);
  }

  console.log("\n" + table.toString());
}

/**
 * Format optional field with fallback to dim dash
 */
export function optional(value: string | null | undefined): string {
  return value ?? chalk.dim("—");
}

/**
 * Format boolean as yes/no with color
 */
export function yesNo(value: boolean | null | undefined): string {
  if (value === true) return chalk.green("yes");
  if (value === false) return chalk.dim("no");
  return chalk.dim("—");
}

/**
 * Format status with color coding
 */
export function statusColor(
  status: string | null | undefined,
  colorMap: Record<string, (text: string) => string> = {},
): string {
  if (!status) return chalk.dim("—");

  const defaultMap: Record<string, (text: string) => string> = {
    completed: chalk.green,
    success: chalk.green,
    failed: chalk.red,
    error: chalk.red,
    pending: chalk.yellow,
    in_progress: chalk.yellow,
    ...colorMap,
  };

  const colorFn = defaultMap[status.toLowerCase()] || ((s: string) => s);
  return colorFn(status);
}

export interface EmptyStateInstructions {
  message?: string;
  commands?: string[];
  locations?: string[];
  helpUrl?: string;
}

/**
 * Generic empty state message with optional helpful instructions
 *
 * @example
 * ```ts
 * printEmpty('assistants', {
 *   message: 'Create assistants to get started',
 *   commands: ['codemie sdk assistants create --data @assistant.json'],
 *   helpUrl: 'https://docs.codemie.ai/assistants'
 * });
 * ```
 */
export function printEmpty(
  entityType: string,
  instructions?: EmptyStateInstructions,
): void {
  console.log(chalk.yellow(`\nNo ${entityType} found.`));

  if (!instructions) {
    return;
  }

  // Optional custom message
  if (instructions.message) {
    console.log(chalk.white(instructions.message));
    console.log("");
  }

  // Commands to run
  if (instructions.commands && instructions.commands.length > 0) {
    console.log(chalk.white("Create new with:"));
    for (const cmd of instructions.commands) {
      console.log(`  ${chalk.cyan(cmd)}`);
    }
    console.log("");
  }

  // Locations/paths
  if (instructions.locations && instructions.locations.length > 0) {
    console.log(chalk.white("Or manage via:"));
    for (const loc of instructions.locations) {
      console.log(`  • ${chalk.cyan(loc)}`);
    }
    console.log("");
  }

  // Help URL
  if (instructions.helpUrl) {
    console.log(chalk.white("Learn more:"));
    console.log(`  ${chalk.cyan(instructions.helpUrl)}`);
    console.log("");
  }
}

/**
 * Generic list header
 */
export function printListHeader(entityType: string, count: number): void {
  console.log(chalk.bold(`\n${entityType} (${count})`));
}

/**
 * Generic success message for create/update/delete operations
 */
export function printSuccess(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

/**
 * Print additional info line (dimmed)
 */
export function printInfo(message: string): void {
  console.log(chalk.dim(`  ${message}`));
}
