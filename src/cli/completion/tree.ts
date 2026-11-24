import type { Command, Option } from 'commander';
import { isHiddenCommand, isHiddenOption } from '@/cli/hidden.js';

/*
 * Root-option rule (verified empirically against the built CLI):
 *   `codemie list --version` prints the version and `codemie list --task x`
 *   reaches the --task handler, i.e. root options (--task, -V, --version) are
 *   accepted AFTER a subcommand (src/cli/index.ts scans argv for --task).
 *   Therefore emitters offer the root's options at every node, not only root.
 * buildModel itself records each node's own options only; the root-only
 * `-V/--version` and `--task` live on the root node. Emitters MUST obtain a
 * node's offered options through `effectiveOptions(root, node)`, which merges
 * the root's options with the node's own (deduped by long/short; node wins).
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
      subs: [],
    });
  }

  return { name: cmd.name(), aliases: cmd.aliases(), description: cmd.description(), options, subs };
}

export function buildModel(root: Command): NodeModel {
  return buildNode(root);
}

function sameOption(a: OptionModel, b: OptionModel): boolean {
  return (!!a.long && a.long === b.long) || (!!a.short && a.short === b.short);
}

/**
 * Options offered at `node`: the node's own options followed by the root's
 * options that the node does not redeclare (matched by long or short name).
 */
export function effectiveOptions(root: NodeModel, node: NodeModel): OptionModel[] {
  if (node === root) return [...root.options];
  const merged = [...node.options];
  for (const opt of root.options) {
    if (!merged.some(m => sameOption(m, opt))) merged.push(opt);
  }
  return merged;
}
