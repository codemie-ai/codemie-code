import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';

/**
 * The flag rows of a bare-command target list (`proxy connect`, `proxy disconnect`): each flag padded to the longest
 * flag of the list, so every description starts at one column.
 */

/** A flag (or flags, e.g. `--vscode --insiders`) and its one-line description. */
export type FlagRow = readonly [flag: string, description: string];

/** The rows as list lines: two-space indent, the flag padded to the longest flag plus two spaces, the description. */
export function formatFlagRows(rows: readonly FlagRow[]): string[] {
  const width = Math.max(0, ...rows.map(([flag]) => flag.length));
  return rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`);
}

/** The vendor flags of `proxy connect` / `proxy disconnect` (#833): every Claude client, every Copilot client. */
export const CLAUDE_OTLP_FLAG = '--claude-otlp';
export const COPILOT_OTLP_FLAG = '--copilot-otlp';

/** The deprecated per-connector flags and the vendor flag every hint names instead. */
const VENDOR_FLAG_OF: Readonly<Record<string, string>> = {
  [`--${CLAUDE_CODE_OTLP_AGENT_NAME}`]: CLAUDE_OTLP_FLAG,
  [`--${COPILOT_CHAT_OTLP_AGENT_NAME}`]: COPILOT_OTLP_FLAG,
  [`--${COPILOT_CLI_OTLP_AGENT_NAME}`]: COPILOT_OTLP_FLAG,
};

/** The flag a printed `connect` / `disconnect` command names: a per-connector flag's vendor flag, any other as given. */
export function vendorFlag(flag: string): string {
  return VENDOR_FLAG_OF[flag] ?? flag;
}

/** {@link vendorFlag} over a flag list, each flag once, in first-seen order. */
export function vendorFlags(flags: readonly string[]): string[] {
  return [...new Set(flags.map(vendorFlag))];
}
