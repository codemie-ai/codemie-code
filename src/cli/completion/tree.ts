import type { Command, Option } from 'commander';
import { isHiddenCommand, isHiddenOption } from '@/cli/hidden.js';

/*
 * Root-option rule (verified empirically against the built CLI):
 *   `codemie list --version` prints the version and `codemie list --task x`
 *   reaches the --task handler, i.e. root options (--task, -V, --version) are
 *   accepted AFTER a subcommand (src/cli/index.ts scans argv for --task).
 *   Therefore emitters offer the root's options at every node, not only root.
 * buildModel itself records each node's own options only; the root-only
 * `-V/--version` and `--task` live on the root node and emitters propagate them.
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
  subs: NodeModel[];
}

const PATH_PLACEHOLDER = /[<[](path|file|dir)[>\]]/i;

function modelOption(opt: Option): OptionModel {
  const takesValue = opt.required ? 'required' : opt.optional ? 'optional' : 'none';
  const choices = opt.argChoices ? [...opt.argChoices] : [];
  const valueKind: ValueKind =
    takesValue === 'none' ? 'none' : PATH_PLACEHOLDER.test(opt.flags) ? 'path' : 'value';
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
      subs: [],
    });
  }

  return { name: cmd.name(), aliases: cmd.aliases(), description: cmd.description(), options, subs };
}

export function buildModel(root: Command): NodeModel {
  return buildNode(root);
}
