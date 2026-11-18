/**
 * Shared prompt and stop guidance for the cloud-provider settings conflict.
 *
 * `askSwitchOrCancel` asks the one question every flow shares; `stopGuidance` builds the text a caller
 * shows when it stops. Neither ends the process: callers act on the returned value. Output carries paths
 * and key names only (never setting values), all neutralised for terminal display.
 */
import inquirer from 'inquirer';
import { sanitizeDisplayText } from '@/utils/project-binding.js';
import { logger } from '@/utils/logger.js';
import type { CloudProviderDescriptor } from './provider.js';
import type { ConflictFlow, ConflictLayer, ConflictResolution, ConflictScope } from './resolver.js';
import { isManagedScope, printLine } from './shared.js';

export type PromptChoice = 'switch' | 'cancel';

/** Why a caller stops without changing anything. Matches the gate's stop reasons. */
export type StopReason = 'cancel' | 'managed' | 'unknown' | 'non-interactive';

/** What the prompt and the guidance describe: the resolver result plus the flow and provider it was resolved for. */
export interface ConflictFindings {
  resolution: ConflictResolution;
  flow: ConflictFlow;
  provider: CloudProviderDescriptor;
}

export interface SwitchQuestion {
  type: 'list';
  name: 'choice';
  message: string;
  choices: Array<{ name: string; value: PromptChoice }>;
  default: PromptChoice;
}

export type SwitchPrompt = (questions: SwitchQuestion[]) => Promise<{ choice: PromptChoice }>;

/** Seams for tests; production uses inquirer and console output. */
export interface SwitchPromptDeps {
  prompt?: SwitchPrompt;
  print?: (line: string) => void;
}

const SWITCH_LABEL = 'Back up and switch to the CodeMie gateway';
const CANCEL_LABEL = 'Cancel';

const SCOPE_LABELS: Record<ConflictScope, string> = {
  user: 'user settings',
  project: 'shared project settings, often tracked in git',
  'project-local': 'local project settings',
  managed: 'managed policy',
  env: 'shell environment',
  vscode: 'VS Code settings',
  'desktop-applied': 'Claude Desktop applied config',
  'desktop-managed': 'Claude Desktop managed config',
};

const defaultPrompt: SwitchPrompt = async (questions) =>
  (await inquirer.prompt(questions as unknown as Parameters<typeof inquirer.prompt>[0])) as { choice: PromptChoice };

function safe(value: string): string {
  return sanitizeDisplayText(value);
}

function names(keys: string[]): string {
  return keys.map(safe).join(', ');
}

/** Layers that set the flag or carry any of its keys. */
function foundLayers(resolution: ConflictResolution): ConflictLayer[] {
  return resolution.layers.filter((l) => l.setsFlag || l.keyNames.length > 0);
}

function describeLayer(layer: ConflictLayer): string {
  const keys = layer.keyNames.length > 0 ? `: ${names(layer.keyNames)}` : '';
  return `  - ${safe(layer.path)} (${SCOPE_LABELS[layer.scope]})${keys}`;
}

function isConnectFlow(flow: ConflictFlow): boolean {
  return flow.startsWith('connect-');
}

function promptLines(findings: ConflictFindings): string[] {
  const { provider, flow, resolution } = findings;
  const name = safe(provider.displayName);
  const lines: string[] = [
    '',
    `${name} settings were found in your Claude configuration:`,
    ...foundLayers(resolution).map(describeLayer),
    '',
    `${name} and the CodeMie gateway cannot both be active in one Claude configuration.`,
  ];

  const extra = resolution.layers.filter((l) => l.editable && !l.setsFlag && l.bedrockModelKeys.length > 0);
  if (extra.length > 0) {
    lines.push('', `${name} model keys that will also be removed from files that do not set the flag:`);
    for (const layer of extra) lines.push(`  - ${safe(layer.path)}: ${names(layer.bedrockModelKeys)}`);
  }
  if (resolution.layers.some((l) => l.scope === 'vscode' && l.editable && l.keyNames.length > 0)) {
    lines.push('', 'In VS Code settings, whole environment-variable entries are removed, not only their values.');
  }

  lines.push('', 'Running Claude sessions watch these files and may need a restart after the change.');
  if (flow === 'install') {
    lines.push('Installing only prepares the agent: nothing routes to the gateway until the next codemie-claude run.');
  }
  const bypasses = connectSentence(flow);
  if (bypasses.length > 0) lines.push('', ...bypasses);
  lines.push('');
  return lines;
}

/**
 * Ask whether to back up the Bedrock settings and switch to the gateway. Ctrl-C counts as cancel: a
 * prompt-scoped SIGINT listener owns it (installed inquirer re-raises SIGINT instead of rejecting), with a
 * ref'd keep-alive so the event loop cannot drain before the prompt settles.
 */
export async function askSwitchOrCancel(findings: ConflictFindings, deps: SwitchPromptDeps = {}): Promise<PromptChoice> {
  const prompt = deps.prompt ?? defaultPrompt;
  const print = deps.print ?? printLine;

  for (const line of promptLines(findings)) print(line);

  let onSigint: () => void = () => undefined;
  const interrupted = new Promise<PromptChoice>((resolve) => {
    onSigint = (): void => resolve('cancel');
  });
  process.on('SIGINT', onSigint);
  const keepAlive = setInterval(() => undefined, 1 << 30);
  try {
    const asked: Promise<PromptChoice> = prompt([
      {
        type: 'list',
        name: 'choice',
        message: 'How do you want to continue?',
        choices: [
          { name: SWITCH_LABEL, value: 'switch' },
          { name: CANCEL_LABEL, value: 'cancel' },
        ],
        default: 'cancel',
      },
    ]).then(
      (answer) => (answer.choice === 'switch' ? 'switch' : 'cancel'),
      (error: unknown) => {
        // A prompt that closes without an answer (for example by Ctrl-C) is a cancel, never a switch.
        logger.debug('[cloud-provider-conflict] prompt closed without an answer', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 'cancel';
      }
    );
    return await Promise.race([asked, interrupted]);
  } finally {
    clearInterval(keepAlive);
    process.removeListener('SIGINT', onSigint);
  }
}

/** The bypasses a connect run cannot see; stated whenever a connect flow stops or switches. */
function connectSentence(flow: ConflictFlow): string[] {
  return isConnectFlow(flow)
    ? [
        'Connect flows check only the user, managed, Desktop and VS Code layers; a Bedrock project elsewhere is not seen by them.',
        'Claude Desktop managed policy on macOS and Windows is not detected.',
        'Claude Code policy in the Windows registry is not detected.',
        'A --settings file passed to Claude is not read.',
      ]
    : [];
}

/** First sentence of the unknown guidance: the resolver's reason, or the layer and key that could not be told. */
function unknownDetail(resolution: ConflictResolution): string {
  if (resolution.unknownReason) return safe(resolution.unknownReason);
  const unclear = resolution.layers.filter((l) => l.state === 'malformed' || l.state === 'unreadable' || l.flag === 'unknown');
  if (unclear.length === 0) return 'a Claude settings source could not be read';
  return unclear.map((l) => `${safe(l.path)}: ${safe(l.flagKey)} cannot be read or has an unrecognised value`).join('; ');
}

/**
 * Text a caller prints when it stops without changing anything. Returns text only: no printing, no ending
 * the process.
 */
export function stopGuidance(reason: StopReason, findings: ConflictFindings): string {
  const { provider, flow, resolution } = findings;
  const name = safe(provider.displayName);
  const found = foundLayers(resolution).map(describeLayer);
  const lines: string[] = [];

  switch (reason) {
    case 'cancel':
      lines.push(`${name} settings were found and left as they are:`, ...found, '');
      lines.push('Nothing was changed.');
      lines.push(
        `To use the CodeMie gateway, remove the ${name} settings listed above, or rerun this command and choose switch.`
      );
      break;
    case 'unknown':
      lines.push(`CodeMie cannot tell whether ${name} is active: ${unknownDetail(resolution)}.`);
      lines.push('Fix that key (use 1/true/yes/on or 0/false/no/off) or the file itself, then rerun this command.');
      lines.push('Nothing was changed.');
      break;
    case 'managed': {
      const managed = resolution.layers.filter((l) => isManagedScope(l) && l.setsFlag);
      lines.push(`${name} is enabled by a managed policy set by your IT administrator:`, ...managed.map(describeLayer), '');
      lines.push('CodeMie cannot change it and does not ask. Ask your administrator to change it, or use Claude without the CodeMie gateway.');
      lines.push('Nothing was changed.');
      break;
    }
    case 'non-interactive':
      lines.push(`${name} settings were found, and no prompt is available here (non-interactive: ACP, --task, no TTY, CODEMIE_NO_PROMPTS, --silent or a scripted install):`, ...found, '');
      lines.push('Nothing was changed.');
      lines.push(`To use the CodeMie gateway, remove the ${name} settings listed above, or rerun this command interactively and choose switch.`);
      break;
  }

  lines.push(...connectSentence(flow));
  return lines.join('\n');
}
