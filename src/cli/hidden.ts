import type { Command, Option } from 'commander';

interface HiddenFlag {
  _hidden?: boolean;
}

/**
 * Commander exposes no public getter for a command's hidden flag (only
 * `addCommand(cmd, { hidden: true })` sets it), so this is the single place
 * in the repo that touches the private `_hidden` field.
 */
export function isHiddenCommand(cmd: Command): boolean {
  return (cmd as unknown as HiddenFlag)._hidden === true;
}

/** Hide a command from help/completions regardless of how it is registered. */
export function markHidden(cmd: Command): void {
  (cmd as unknown as HiddenFlag)._hidden = true;
}

/** Whether an option is hidden from help (`Option.hideHelp()`); `hidden` is public. */
export function isHiddenOption(opt: Option): boolean {
  return opt.hidden === true;
}
