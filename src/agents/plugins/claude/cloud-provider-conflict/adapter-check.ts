/**
 * The Claude adapters' `checkProviderSettings`: maps the agent-agnostic check of `AgentAdapter` onto the
 * cloud-provider conflict gate. Core and the CLI only see the adapter hook and its outcome; which Claude
 * flows exist, which files each reads and how a switch is applied stay inside this plugin.
 */
import type {
  ProviderSettingsCheckInput,
  ProviderSettingsCheckOutcome,
  ProviderSettingsConnectTargets,
} from '@/agents/core/types.js';
import chalk from 'chalk';
import { applyConsented, detectAndAsk, dropInheritedBedrockFlag, type DetectAndAskInput } from './gate.js';
import type { ConflictFlow, ConflictPaths } from './resolver.js';

/** One gate run: the Claude flow and the extra files only the caller can name. */
interface GateTarget {
  flow: ConflictFlow;
  paths?: ConflictPaths;
}

/** Test seams passed through to the gate (paths, platform, env, prompt, switch). */
export type AdapterCheckDeps = Omit<DetectAndAskInput, 'flow' | 'canPrompt' | 'profile'>;

const PROCEED_NOTHING_TO_APPLY: ProviderSettingsCheckOutcome = {
  kind: 'proceed',
  apply: async () => ({ backupDir: null }),
};

/**
 * Desktop and VS Code targets are resolved together, so a run that connects both asks once. Project settings
 * are never read for connect: it configures the user's apps, not a project. Claude Code analytics on its own
 * is only warned about.
 */
function connectTarget(targets: ProviderSettingsConnectTargets): GateTarget | null {
  const { desktop, vscodeSettingsFiles } = targets;
  if (desktop || vscodeSettingsFiles) {
    const paths: ConflictPaths = {};
    if (desktop) {
      paths.desktopApplied = desktop.configFile;
      paths.desktopManaged = desktop.managedFile;
    }
    if (vscodeSettingsFiles) paths.vscodeSettings = vscodeSettingsFiles;
    return { flow: desktop ? 'connect-desktop' : 'connect-vscode', paths };
  }
  return targets.claudeCodeOtlp ? { flow: 'connect-otlp-only' } : null;
}

function gateTarget(input: ProviderSettingsCheckInput): GateTarget | null {
  switch (input.flow) {
    case 'launch':
      return { flow: 'claude-agent' };
    case 'install':
      return { flow: 'install' };
    case 'connect':
      return input.connect ? connectTarget(input.connect) : null;
  }
}

/**
 * Runs the Bedrock settings gate for one Claude adapter. For a launch, the inherited shell flag is dropped
 * from `process.env` first (the child env is built from it), so the gate never asks on the shell's account.
 *
 * @param agent - The adapter's name (`claude` or `claude-acp`)
 * @param input - The core check input
 * @param deps - Test seams; production passes none
 */
export async function checkClaudeProviderSettings(
  agent: string,
  input: ProviderSettingsCheckInput,
  deps: AdapterCheckDeps = {}
): Promise<ProviderSettingsCheckOutcome> {
  const profile = input.profile ?? null;
  if (input.flow === 'launch') {
    dropInheritedBedrockFlag({ agent, provider: profile?.provider, env: deps.env });
  }
  const target = gateTarget(input);
  if (!target) return PROCEED_NOTHING_TO_APPLY;

  const outcome = await detectAndAsk({
    ...deps,
    flow: target.flow,
    paths: target.paths ?? deps.paths,
    canPrompt: input.canPrompt,
    profile,
  });
  if (outcome.kind === 'stop') return { kind: 'stop', guidance: outcome.guidance };
  const { token } = outcome;
  return {
    kind: 'proceed',
    apply: async () => {
      const { backupDir } = await applyConsented(token);
      if (backupDir !== null && input.flow === 'install') {
        console.log(chalk.yellow('Nothing routes to the CodeMie gateway until the next codemie-claude run.'));
      }
      return { backupDir };
    },
  };
}
