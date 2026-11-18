/**
 * The analytics-scope pre-flight of `codemie proxy connect` (D7, D18): before SSO, the daemon or any config is
 * touched, a user-scope connect that would drop tracked projects lists them and asks; afterwards each analytics
 * writer runs only while the confirmed project list is still the one on disk.
 */
import chalk from 'chalk';
import { renderHint } from '@/utils/hint.js';
import { isNonInteractiveEnvironment } from '@/utils/interactive.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.constants.js';
import type { AllowlistScope } from '@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.constants.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';
import { ANALYTICS_CONNECTORS, type AnalyticsConnectorId, type ConnectorScopeRead } from './analytics-connectors.js';
import { ANALYTICS_AGGREGATES } from './analytics-clients.js';
import { buildScopeDropLines, promptScopeDropConfirmation } from './prompts/analytics-confirmation.js';
import type { ConnectTargets, TargetResult } from './connect-orchestrator.js';

/** The targets `--scope` and `--yes` apply to, as named in their ignored-flag notes. */
const ANALYTICS_TARGET_FLAGS = [
  ...ANALYTICS_AGGREGATES.map((aggregate) => aggregate.flag),
  `--${CLAUDE_CODE_OTLP_AGENT_NAME}`,
  `--${COPILOT_CHAT_OTLP_AGENT_NAME}`,
  `--${COPILOT_CLI_OTLP_AGENT_NAME}`,
].join(' / ');

/** `--scope` and `--yes` apply only to analytics connector targets: say so when neither is selected. */
export function warnIgnoredAnalyticsFlags(targets: ConnectTargets, scope: AllowlistScope | undefined, yes: boolean): void {
  const hasAnalyticsTarget = Boolean(targets.claudeCodeOtlp || targets.copilotChatOtlp || targets.copilotCliOtlp);
  if (scope && !hasAnalyticsTarget) {
    console.log(chalk.yellow(`Note: --scope has no effect without an analytics connector target (${ANALYTICS_TARGET_FLAGS}).`));
  }
  if (yes && !hasAnalyticsTarget) {
    console.log(chalk.yellow(`Note: --yes has no effect without an analytics connector target (${ANALYTICS_TARGET_FLAGS}).`));
  }
}

export type AnalyticsTargetKey = 'claudeCodeOtlp' | 'copilotChatOtlp' | 'copilotCliOtlp';

export interface AnalyticsTarget {
  id: AnalyticsConnectorId;
  key: AnalyticsTargetKey;
  label: string;
}

/** The analytics connector targets, in dispatch order. */
export const ANALYTICS_TARGETS: readonly AnalyticsTarget[] = [
  { id: CLAUDE_CODE_OTLP_AGENT_NAME, key: 'claudeCodeOtlp', label: 'Claude Code analytics' },
  { id: COPILOT_CHAT_OTLP_AGENT_NAME, key: 'copilotChatOtlp', label: 'Copilot Chat analytics' },
  { id: COPILOT_CLI_OTLP_AGENT_NAME, key: 'copilotCliOtlp', label: 'Copilot CLI analytics' },
];

/** Each requested connector's project list as read before anything changed; only kept for a user-scope connect. */
export type ScopeBaselines = Map<AnalyticsConnectorId, ConnectorScopeRead>;

async function readConnectorScope(id: AnalyticsConnectorId): Promise<ConnectorScopeRead> {
  const entry = ANALYTICS_CONNECTORS.find((connector) => connector.id === id);
  return entry ? entry.readScope() : { scope: 'user', paths: [] };
}

function samePaths(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedB = [...b].sort();
  return [...a].sort().every((path, index) => path === sortedB[index]);
}

function sameScopeRead(a: ConnectorScopeRead, b: ConnectorScopeRead): boolean {
  if ('invalid' in a || 'invalid' in b) return 'invalid' in a && 'invalid' in b;
  return a.scope === b.scope && samePaths(a.paths, b.paths);
}

/**
 * A user-scope connect (`--scope user` or no `--scope`) resets a connector's project list, so every requested
 * analytics connector in project scope with tracked projects lists them and asks first; `--yes` skips the prompt
 * and is the only non-interactive path. Runs before SSO, the daemon or any config is touched. A decline clears
 * that connector from `activeTargets`. Returns the baselines the writers check later, or `null` when the run must
 * stop (the non-interactive failure already set the exit code). An unreadable list needs no confirmation, and
 * neither does a connector in `keptLists` (set by `--claude-otlp` / `--copilot-otlp` with no `--scope`), whose
 * writer keeps its project list.
 */
export async function confirmScopeDrops(
  activeTargets: ConnectTargets,
  scope: AllowlistScope | undefined,
  yes: boolean,
  keptLists: ReadonlySet<AnalyticsTargetKey> = new Set(),
): Promise<ScopeBaselines | null> {
  const baselines: ScopeBaselines = new Map();
  if (scope === 'project') return baselines;

  const drops: Array<{ target: AnalyticsTarget; paths: string[] }> = [];
  for (const target of ANALYTICS_TARGETS) {
    if (!activeTargets[target.key] || keptLists.has(target.key)) continue;
    const read = await readConnectorScope(target.id);
    baselines.set(target.id, read);
    if (!('invalid' in read) && read.scope === 'project' && read.paths.length > 0) {
      drops.push({ target, paths: read.paths });
    }
  }
  if (drops.length === 0) return baselines;

  if (!yes && isNonInteractiveEnvironment()) {
    const flags = drops.map(({ target }) => `--${target.id}`).join(' ');
    console.error(chalk.red(`✗ ${renderHint({
      reason: 'Confirmation needed to drop tracked projects',
      command: `codemie proxy connect ${flags} --scope user --yes`,
    })}`));
    process.exitCode = 1;
    return null;
  }

  for (const { target, paths } of drops) {
    if (yes) {
      for (const line of buildScopeDropLines({ label: target.label, paths })) console.log(line);
      continue;
    }
    if (await promptScopeDropConfirmation({ label: target.label, paths }) !== 'confirm') {
      activeTargets[target.key] = false;
      console.log(chalk.yellow(`${target.label} was not changed.`));
    }
  }
  return baselines;
}

/**
 * Runs an analytics writer only while the connector's project list still equals the one read (and confirmed)
 * before the run; otherwise skips that connector with a message and reports it as not configured.
 */
export async function runIfScopeUnchanged(
  target: AnalyticsTarget,
  baselines: ScopeBaselines,
  run: () => Promise<TargetResult>,
): Promise<TargetResult> {
  const baseline = baselines.get(target.id);
  if (baseline && !sameScopeRead(baseline, await readConnectorScope(target.id))) {
    const message = 'its tracked project list changed after confirmation';
    console.log(chalk.yellow(`  ${renderHint({
      reason: `${target.label} skipped: ${message}`,
      command: `codemie proxy connect --${target.id}`,
    })}`));
    return { label: target.label, ok: false, error: message };
  }
  return run();
}
