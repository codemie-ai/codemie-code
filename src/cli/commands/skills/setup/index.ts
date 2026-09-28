import { Command } from 'commander';
import chalk from 'chalk';
import type { SkillDetail, SkillListItem } from 'codemie-sdk';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { getAuthenticatedClient } from '@/utils/auth.js';
import { createSkillDataFetcher } from './data.js';
import { promptSkillSelection } from './selection/index.js';
import { determineChanges, registerSkill, unregisterSkill } from './helpers.js';
import { ACTION_TYPE } from './constants.js';
import {
  enableVerboseLogging,
  handleSetupError,
  persistPartialWrites,
  registerAllOrAbort,
} from '@/cli/commands/shared/helpers.js';
import { promptStorageScope } from '@/cli/commands/shared/prompts/storage-scope.js';
import {
  resolveAgentSetupTargets,
  formatAgentSetupTarget,
  type AgentSetupTarget,
  type TargetAgent,
} from '@/cli/commands/shared/agent-targets.js';
import {
  isHeadlessMode,
  requireFlag,
  parseScopeFlag,
  parseListFlag,
  partitionRegisteredByRequest,
  resolveHeadlessAgentTarget,
} from '@/cli/commands/shared/headless.js';
import { resolveIdentifiers } from '@/cli/commands/shared/identifier-resolution.js';
import { RegistrationItemNotFoundError } from '@/utils/errors.js';
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
    .option('-y, --yes', 'Run non-interactively; requires --skill, --scope and --agent')
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

  // Pre-flight: fetchSkillsByIds already read every selected skill's details, so
  // any unreadable one has aborted the run before the first write.
  const details = new Map(selectedSkills.map(skill => [skill.id, skill]));

  for (const skill of toUnregister) {
    await unregisterSkill(skill, storageScope, workingDir, target);
  }

  await registerAndSaveSkills({
    toRegister,
    details,
    carriedOver: registeredSkills.filter(s => selectedIds.includes(s.id)),
    unregisteredCount: toUnregister.length,
    scope: storageScope,
    workingDir,
    target,
  });
}

interface RegisterAndSaveParams {
  toRegister: SkillListItem[];
  details: Map<string, SkillDetail>;
  /** Registrations that must survive the save regardless of this batch. */
  carriedOver: CodemieSkill[];
  unregisteredCount: number;
  scope: StorageScope;
  workingDir: string;
  target: AgentSetupTarget;
}

/**
 * Writes the selected skills from their pre-fetched details and saves the config,
 * including when the batch aborts partway: whatever reached disk is recorded before
 * the error propagates, so the config never claims less than what exists.
 */
async function registerAndSaveSkills(params: RegisterAndSaveParams): Promise<void> {
  const { toRegister, details, carriedOver, scope, workingDir, target } = params;
  const written: CodemieSkill[] = [];
  const save = (items: CodemieSkill[]): Promise<void> =>
    ConfigLoader.saveSkillsToProjectConfig(workingDir, scope, items);

  try {
    const newlyRegistered = await registerAllOrAbort(
      toRegister,
      (skill) => skill.name,
      async (skill) => {
        const registration = await registerSkill(
          requireSkillDetail(details, skill.id),
          scope,
          workingDir,
          target
        );
        written.push(registration);
        return registration;
      }
    );

    await save([...carriedOver, ...newlyRegistered]);
    printSkillsSummary(newlyRegistered.length, params.unregisteredCount, scope, workingDir, target);
  } catch (error) {
    await persistPartialWrites(written, carriedOver, save);
    throw error;
  }
}

/**
 * Fetches the detail payload of every skill that is about to be written. This is the
 * call that proves the caller can actually read the skill, so it runs for the whole
 * batch up front: inside the write loop, a 403 on the last skill would abort only
 * after earlier artifacts had already been written.
 */
async function prefetchSkillDetails(
  skills: SkillListItem[],
  fetcher: ReturnType<typeof createSkillDataFetcher>
): Promise<Map<string, SkillDetail>> {
  const details = new Map<string, SkillDetail>();

  for (const skill of skills) {
    details.set(skill.id, await fetcher.fetchSkillById(skill.id));
  }

  return details;
}

function requireSkillDetail(details: Map<string, SkillDetail>, id: string): SkillDetail {
  const detail = details.get(id);

  if (!detail) {
    throw new RegistrationItemNotFoundError('skill', id);
  }

  return detail;
}

function printSkillsSummary(
  registeredCount: number,
  unregisteredCount: number,
  scope: StorageScope,
  workingDir: string,
  target: AgentSetupTarget
): void {
  const configLocation = ConfigLoader.getConfigLocationLabel(scope, workingDir);

  console.log('');
  if (registeredCount > 0) {
    console.log(chalk.green(`✓ Registered ${registeredCount} skill(s)`));
  }
  if (unregisteredCount > 0) {
    console.log(chalk.yellow(`○ Unregistered ${unregisteredCount} skill(s)`));
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

  const { identifiers, storageScope, target } = parseHeadlessSkillFlags(options, hostAgent);

  printSkillsNotice();

  const config = await ConfigLoader.load(workingDir, { name: profileName });
  const client = await getAuthenticatedClient(config, { nonInteractive: true });
  const registeredSkills = await ConfigLoader.loadSkillsByScope(storageScope, workingDir, profileName);

  const fetcher = createSkillDataFetcher({ client, registeredSkills });
  const catalog = await fetcher.fetchAllVisibleSkills();

  const resolvedSkills = resolveIdentifiers('skill', identifiers, catalog);
  const selectedIds = Array.from(new Set(resolvedSkills.map(skill => skill.id)));
  const { inScope } = partitionRegisteredByRequest(registeredSkills, selectedIds);

  // Headless registration is purely additive: every already-registered skill the
  // request does not name survives the save untouched.
  const carryOver = (written: CodemieSkill[]): CodemieSkill[] => {
    const writtenIds = new Set(written.map(skill => skill.id));
    return registeredSkills.filter(skill => !writtenIds.has(skill.id));
  };
  const written: CodemieSkill[] = [];
  const save = (items: CodemieSkill[]): Promise<void> =>
    ConfigLoader.saveSkillsToProjectConfig(workingDir, storageScope, items);

  try {
    const { newlyRegistered, unregistered } = await applySkillChanges(
      { selectedIds, catalog, registeredSkills: inScope, scope: storageScope, workingDir, target, fetcher },
      written
    );

    if (newlyRegistered.length === 0 && unregistered.length === 0) {
      return;
    }

    await save([...carryOver(newlyRegistered), ...newlyRegistered]);
    printSkillsSummary(newlyRegistered.length, unregistered.length, storageScope, workingDir, target);
  } catch (error) {
    await persistPartialWrites(written, carryOver(written), save);
    throw error;
  }
}

interface HeadlessSkillFlags {
  identifiers: string[];
  storageScope: StorageScope;
  target: AgentSetupTarget;
}

/**
 * Validates and parses every headless input before any network call or write, so a
 * missing or invalid flag aborts with an error naming it. `--agent` may come from
 * the hosting agent (`codemie-<agent> setup skills`); nothing else is inferred.
 */
function parseHeadlessSkillFlags(
  options: SetupCommandOptions,
  hostAgent?: TargetAgent
): HeadlessSkillFlags {
  return {
    identifiers: parseListFlag(requireFlag(options.skill, '--skill')),
    storageScope: parseScopeFlag(requireFlag(options.scope, '--scope')),
    target: resolveHeadlessAgentTarget(options.agent, hostAgent),
  };
}

interface ApplySkillChangesResult {
  newlyRegistered: CodemieSkill[];
  unregistered: CodemieSkill[];
}

interface ApplySkillChangesParams {
  selectedIds: string[];
  catalog: SkillListItem[];
  registeredSkills: CodemieSkill[];
  scope: StorageScope;
  workingDir: string;
  target: AgentSetupTarget;
  fetcher: ReturnType<typeof createSkillDataFetcher>;
}

async function applySkillChanges(
  params: ApplySkillChangesParams,
  /** Collects each registration as it reaches disk, so a caller can record a partial batch. */
  writeSink?: CodemieSkill[]
): Promise<ApplySkillChangesResult> {
  const { selectedIds, catalog, registeredSkills, scope, workingDir, target, fetcher } = params;
  const { toRegister, toUnregister } = determineChanges(selectedIds, catalog, registeredSkills);
  const selectedSet = new Set(selectedIds);
  const toReregister = registeredSkills.filter(s => selectedSet.has(s.id));

  if (toRegister.length === 0 && toUnregister.length === 0 && toReregister.length === 0) {
    console.log(chalk.yellow('\nNo changes to apply.\n'));
    return { newlyRegistered: [], unregistered: [] };
  }

  const allToRegister = [...toRegister, ...getFullSkills(toReregister, catalog)];

  // Pre-flight: prove every skill is readable before the first artifact is written,
  // and before any existing registration is removed.
  const details = await prefetchSkillDetails(allToRegister, fetcher);

  for (const skill of toUnregister) {
    await unregisterSkill(skill, scope, workingDir, target);
  }

  const previousById = new Map(toReregister.map(skill => [skill.id, skill]));

  const newlyRegistered = await registerAllOrAbort(
    allToRegister,
    (skill) => skill.name,
    (skill) => writeOneSkill(skill, {
      details,
      previous: previousById.get(skill.id),
      scope,
      workingDir,
      target,
      writeSink,
    })
  );

  return { newlyRegistered, unregistered: toUnregister };
}

interface WriteSkillContext {
  details: Map<string, SkillDetail>;
  /** The existing registration this write replaces, when the skill is being re-registered. */
  previous?: CodemieSkill;
  scope: StorageScope;
  workingDir: string;
  target: AgentSetupTarget;
  writeSink?: CodemieSkill[];
}

async function writeOneSkill(skill: SkillListItem, context: WriteSkillContext): Promise<CodemieSkill> {
  const { details, previous, scope, workingDir, target, writeSink } = context;

  // A re-registration removes its previous artifacts immediately before the
  // replacement is written, never up front for the whole batch: an earlier
  // failure would otherwise leave a working skill deleted and unwritten.
  if (previous) {
    await unregisterSkill(previous, scope, workingDir, target);
  }

  const registration = await registerSkill(requireSkillDetail(details, skill.id), scope, workingDir, target);
  writeSink?.push(registration);

  return registration;
}

function getFullSkills(skills: CodemieSkill[], catalog: SkillListItem[]): SkillListItem[] {
  const byId = new Map(catalog.map(item => [item.id, item]));
  return skills
    .map(skill => byId.get(skill.id))
    .filter((item): item is SkillListItem => item !== undefined);
}
