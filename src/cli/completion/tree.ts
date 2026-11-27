import type { Command, Option } from 'commander';
import { isHiddenCommand, isHiddenOption } from '@/cli/hidden.js';

/*
 * Root-option rule: src/cli/program.ts enables commander's positional-options
 * mode (`.enablePositionalOptions()`), so the root's options (--task, -V,
 * --version) are recognised only BEFORE the subcommand name. `codemie list
 * --version` and `codemie proxy status -V` fail with "unknown option", so they
 * are never offered below the root. buildModel records each node's own options
 * (plus an implicit -h/--help); emitters obtain a node's offered options
 * through `effectiveOptions(node)`.
 */

export type ValueKind = 'none' | 'value' | 'path';

export interface OptionModel {
  long?: string;
  short?: string;
  description: string;
  takesValue: 'none' | 'required' | 'optional';
  valueKind: ValueKind;
  choices: string[];
}

export interface NodeModel {
  name: string;
  aliases: string[];
  description: string;
  options: OptionModel[];
  /** Choices of the first registered positional argument (`.choices([...])`); empty when none. */
  positionalChoices: string[];
  subs: NodeModel[];
}

/** `--task` takes free text (index.ts bypasses commander for it), so its value completes nothing. */
const NO_COMPLETION_OPTION = '--task';

function modelOption(opt: Option): OptionModel {
  const takesValue = opt.required ? 'required' : opt.optional ? 'optional' : 'none';
  const choices = opt.argChoices ? [...opt.argChoices] : [];
  const valueKind: ValueKind =
    takesValue === 'none' ? 'none' : choices.length > 0 || opt.long === NO_COMPLETION_OPTION ? 'value' : 'path';
  return {
    long: opt.long,
    short: opt.short,
    description: opt.description ?? '',
    takesValue,
    valueKind,
    choices,
  };
}

const HELP_OPTION: OptionModel = {
  long: '--help',
  short: '-h',
  description: 'display help for command',
  takesValue: 'none',
  valueKind: 'none',
  choices: [],
};

function buildNode(cmd: Command): NodeModel {
  const options = cmd.options.filter(o => !isHiddenOption(o)).map(modelOption);
  if (!options.some(o => o.long === '--help')) options.push({ ...HELP_OPTION });

  const subs = cmd.commands.filter(c => !isHiddenCommand(c)).map(buildNode);
  if (subs.length > 0 && !subs.some(s => s.name === 'help')) {
    subs.push({
      name: 'help',
      aliases: [],
      description: 'display help for command',
      options: [{ ...HELP_OPTION }],
      positionalChoices: [],
      subs: [],
    });
  }

  const positionalChoices = [...(cmd.registeredArguments[0]?.argChoices ?? [])];

  return {
    name: cmd.name(),
    aliases: cmd.aliases(),
    description: cmd.description(),
    options,
    positionalChoices,
    subs,
  };
}

export function buildModel(root: Command): NodeModel {
  return buildNode(root);
}

/**
 * Options offered at `node`: the node's own options only. The root keeps its
 * own (--task, -V/--version, -h/--help); descendants never inherit them because
 * commander runs in positional-options mode (see the rule at the top of this file).
 */
export function effectiveOptions(node: NodeModel): OptionModel[] {
  return [...node.options];
}
