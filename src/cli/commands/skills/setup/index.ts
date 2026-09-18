import { Command } from 'commander';
import chalk from 'chalk';
import type { SkillListItem } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createSkillDataFetcher } from './data.js';
import { promptSkillSelection } from './selection/index.js';
import { determineChanges, registerSkill, unregisterSkill } from './helpers.js';
import { ACTION_TYPE } from './constants.js';
import { enableVerboseLogging, handleSetupError, registerAllOrAbort } from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import {
  resolveAgentSetupTargets,
  formatAgentSetupTarget,
  parseAgentSetupTarget,
  type AgentSetupTarget,
  type TargetAgent,
} from '@/cli/commands/shared/agent-targets.js';
import { isHeadlessMode, requireFlag, parseScopeFlag, parseListFlag } from '@/cli/commands/shared/headless.js';
import { resolveIdentifiers } from '@/cli/commands/shared/identifier-resolution.js';
import { StorageScope, type CodemieSkill } from '@/env/types.js';

export type { CodemieSkill };

export interface SetupCommandOptions {
  profile?: string;
  agent?: string;
  verbose?: boolean;
  skill?: string;
  scope?: string;
  yes?: boolean;
}

export function createSkillsSetupCommand(hostAgent?: TargetAgent): Command {
  const command = new Command('setup');

  command
    .description('Manage CodeMie platform skills (view, register, unregister)')
    .option('--profile <name>', 'Profile to use')
    .option('--agent <agents>', 'Target agent(s), comma-separated: claude, codex, gemini')
    .option('--skill <ids>', 'Skill identifier(s) to register, comma-separated (id or exact name); enables non-interactive mode')
    .option('--scope <scope>', 'Storage scope for non-interactive registration: global or local')
    .option('-y, --yes', 'Run non-interactively, skipping all prompts')
    .option('-v, --verbose', 'Enable verbose debug output')
    .action(async (options: SetupCommandOptions) => {
      if (options.verbose) {
        enableVerboseLogging();
      }

      try {
        await setupSkills(options, hostAgent);
      } catch (error: unknown) {
        handleSetupError(error, 'setup skills');
      }
    });

  return command;
}

async function showDisclaimer(): Promise<boolean> {
  const ANSI = {
    CLEAR_SCREEN: '\x1B[2J\x1B[H',
    SHOW_CURSOR: '\x1B[?25h',
  } as const;

  const KEY = {
    ENTER: '\r',
    ESC: '\x1B',
    CTRL_C: '\x03',
  } as const;

  const lines = [
    '',
    chalk.yellow('  ⚠  Skills are installed without tools or MCP servers.'),
    '',
    chalk.white('  If you need tools or MCP servers with your skill:'),
    chalk.white('  1. Go to ') + chalk.cyan('https://codemie.lab.epam.com/assistants'),
    chalk.white('  2. Create an assistant and attach your skill to it'),
    chalk.white('  3. Run: ') + chalk.cyan('codemie assistants setup') + chalk.white(' to install the assistant as a skill'),
    '',
    chalk.dim('  Press Enter to continue  ·  Ctrl+C to exit'),
    '',
  ];

  process.stdout.write(lines.join('\n'));

  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeAllListeners('data');
      process.stdout.write(ANSI.SHOW_CURSOR + ANSI.CLEAR_SCREEN);
    }

    process.stdin.on('data', (key: string) => {
      if (key === KEY.ENTER) {
        cleanup();
        resolve(true);
      } else if (key === KEY.ESC || key === KEY.CTRL_C) {
        cleanup();
        resolve(false);
      }
    });
  });
}

async function setupSkills(options: SetupCommandOptions, hostAgent?: TargetAgent): Promise<void> {
  if (isHeadlessMode(options, process.stdin.isTTY === true)) {
    return setupSkillsHeadless(options, hostAgent);
  }

  const profileName = options.profile ?? await ConfigLoader.getActiveProfileName() ?? 'default';
  const workingDir = process.cwd();

  const proceed = await showDisclaimer();
  if (!proceed) {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

  const storageScope = await promptStorageScope({
    title: 'Where would you like to save skills configuration?',
    localNote: 'Project-scoped skills will override global ones for this repository.',
  });
  const target = await resolveAgentSetupTargets(options.agent, hostAgent);

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredSkills: CodemieSkill[] = await ConfigLoader.loadSkillsByScope(storageScope, workingDir, profileName);

  const { selectedIds, action } = await promptSkillSelection(registeredSkills, client);

  if (action === ACTION_TYPE.CANCEL) {
    console.log(chalk.dim('\nNo changes made.\n'));
    return;
  }

  const fetcher = createSkillDataFetcher({ client, registeredSkills });
  const selectedSkills = await fetcher.fetchSkillsByIds(selectedIds, registeredSkills);

  const { toRegister, toUnregister } = determineChanges(selectedIds, selectedSkills, registeredSkills);

  if (toRegister.length === 0 && toUnregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply.\n'));
    return;
  }

  for (const skill of toUnregister) {
    await unregisterSkill(skill, storageScope, workingDir, target);
  }

  const newlyRegistered = await registerAllOrAbort(
    toRegister,
    (skill) => skill.name,
    async (skill) => {
      const detail = await fetcher.fetchSkillById(skill.id);
      return registerSkill(detail, storageScope, workingDir, target);
    }
  );

  const updatedSkills: CodemieSkill[] = [
    ...registeredSkills.filter(s => selectedIds.includes(s.id)),
    ...newlyRegistered,
  ];

  await ConfigLoader.saveSkillsToProjectConfig(workingDir, storageScope, updatedSkills);

  const configLocation = ConfigLoader.getConfigLocationLabel(storageScope, workingDir);

  console.log('');
  if (newlyRegistered.length > 0) {
    console.log(chalk.green(`✓ Registered ${newlyRegistered.length} skill(s)`));
  }
  if (toUnregister.length > 0) {
    console.log(chalk.yellow(`○ Unregistered ${toUnregister.length} skill(s)`));
  }
  console.log(chalk.dim(`\nSkills saved to: ${configLocation}`));
  console.log(chalk.dim(`Skills are available for ${formatAgentSetupTarget(target)}.\n`));
}

/**
 * Prints the same "skills have no tools/MCP servers" notice as the interactive
 * `showDisclaimer()`, minus the ANSI screen control and the Enter/Ctrl+C prompt.
 * Headless mode treats this as informational only, never a consent gate: it is
 * printed through `console.log` and execution continues without reading stdin.
 */
function printSkillsNotice(): void {
  console.log('');
  console.log(chalk.yellow('  ⚠  Skills are installed without tools or MCP servers.'));
  console.log('');
  console.log(chalk.white('  If you need tools or MCP servers with your skill:'));
  console.log(chalk.white('  1. Go to ') + chalk.cyan('https://codemie.lab.epam.com/assistants'));
  console.log(chalk.white('  2. Create an assistant and attach your skill to it'));
  console.log(chalk.white('  3. Run: ') + chalk.cyan('codemie assistants setup') + chalk.white(' to install the assistant as a skill'));
  console.log('');
}

/**
 * Non-interactive branch of `codemie setup skills`. Every prompt (skill
 * selection, storage scope, agent target detection/selection, the disclaimer's
 * Enter gate) is skipped in favour of flags, validated up front so an invalid
 * or missing flag, or an unresolvable identifier, aborts before any network
 * call or write happens.
 */
export async function setupSkillsHeadless(options: SetupCommandOptions, hostAgent?: TargetAgent): Promise<void> {
  const profileName = options.profile ?? await ConfigLoader.getActiveProfileName() ?? 'default';
  const workingDir = process.cwd();
  logger.debug('Setting up skills (headless)', { profileName, options, hostAgent });

  const skillIdentifiers = parseListFlag(requireFlag(options.skill, '--skill'));
  const storageScope = parseScopeFlag(requireFlag(options.scope, '--scope'));
  requireFlag(options.agent, '--agent');

  printSkillsNotice();

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config);
  const registeredSkills = await ConfigLoader.loadSkillsByScope(storageScope, workingDir, profileName);

  const fetcher = createSkillDataFetcher({ client, registeredSkills });
  const catalog = await fetcher.fetchAllVisibleSkills();

  const resolvedSkills = resolveIdentifiers('skill', skillIdentifiers, catalog);
  const target = parseAgentSetupTarget(options.agent as string);

  // Headless registration is purely additive: it must never unregister a skill
  // that isn't named in `--skill`. `determineChanges` derives removals from
  // whichever "currently registered" set it's handed, so the set passed in is
  // scoped down to the overlap with the request (every already-registered skill
  // outside that scope is withheld entirely and reconciled back into the saved
  // list afterwards, untouched).
  const selectedIds = Array.from(new Set(resolvedSkills.map(skill => skill.id)));
  const selectedIdSet = new Set(selectedIds);
  const registeredInScope = registeredSkills.filter(s => selectedIdSet.has(s.id));
  const untouchedRegistered = registeredSkills.filter(s => !selectedIdSet.has(s.id));

  const { newlyRegistered, unregistered } = await applySkillChanges(
    selectedIds,
    catalog,
    registeredInScope,
    storageScope,
    workingDir,
    target,
    fetcher
  );

  if (newlyRegistered.length === 0 && unregistered.length === 0) {
    return;
  }

  const updatedSkills: CodemieSkill[] = [...untouchedRegistered, ...newlyRegistered];

  await ConfigLoader.saveSkillsToProjectConfig(workingDir, storageScope, updatedSkills);

  const configLocation = ConfigLoader.getConfigLocationLabel(storageScope, workingDir);

  console.log('');
  if (newlyRegistered.length > 0) {
    console.log(chalk.green(`✓ Registered ${newlyRegistered.length} skill(s)`));
  }
  if (unregistered.length > 0) {
    console.log(chalk.yellow(`○ Unregistered ${unregistered.length} skill(s)`));
  }
  console.log(chalk.dim(`\nSkills saved to: ${configLocation}`));
  console.log(chalk.dim(`Skills are available for ${formatAgentSetupTarget(target)}.\n`));
}

interface ApplySkillChangesResult {
  newlyRegistered: CodemieSkill[];
  unregistered: CodemieSkill[];
}

async function applySkillChanges(
  selectedIds: string[],
  catalog: SkillListItem[],
  registeredSkills: CodemieSkill[],
  scope: StorageScope,
  workingDir: string,
  target: AgentSetupTarget,
  fetcher: ReturnType<typeof createSkillDataFetcher>
): Promise<ApplySkillChangesResult> {
  const { toRegister, toUnregister } = determineChanges(selectedIds, catalog, registeredSkills);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredSkills.filter(s => selectedSet.has(s.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply.\n'));
    return { newlyRegistered: [], unregistered: [] };
  }

  for (const skill of [...toUnregister, ...toReregister]) {
    await unregisterSkill(skill, scope, workingDir, target);
  }

  const allToRegister = [...toRegister, ...getFullSkills(toReregister, catalog)];

  const newlyRegistered = await registerAllOrAbort(
    allToRegister,
    (skill) => skill.name,
    async (skill) => {
      const detail = await fetcher.fetchSkillById(skill.id);
      return registerSkill(detail, scope, workingDir, target);
    }
  );

  return { newlyRegistered, unregistered: toUnregister };
}

function getFullSkills(skills: CodemieSkill[], catalog: SkillListItem[]): SkillListItem[] {
  const byId = new Map(catalog.map(item => [item.id, item]));
  return skills
    .map(skill => byId.get(skill.id))
    .filter((item): item is SkillListItem => item !== undefined);
}
