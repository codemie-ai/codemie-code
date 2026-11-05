/**
 * Fish completion script generator.
 *
 * Fish's `string` builtins read stdin when given zero STRING arguments, and in
 * a completion context stdin is the user's terminal. Every `string match` /
 * `string split` call below therefore either receives an explicit argument or
 * reads from a pipe (the generated spec function), so an empty candidate list
 * degrades to "no matches" instead of blocking the shell.
 */

import { emitSpec } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

function lines(...parts: string[][]): string {
  return parts.flat().join('\n') + '\n';
}

export function generateFish(roots: RootTree[], candidates: CandidateMap): string {
  const spec = emitSpec('fish', roots, candidates);
  const registrations = roots
    .map((root) => `complete -c ${root.command} -f -a '(__codemie_complete)'`)
    .join('\n');

  return lines(
    ['# codemie shell completions (fish)'],
    ['# Enable with:  codemie completion fish | source'],
    ['# Persist with: codemie completion fish > ~/.config/fish/completions/codemie.fish'],
    [''],
    [spec],
    [
      '# True when flag $argv[2] (on command path $argv[1]) consumes a value.',
      'function __codemie_has_valueflag',
      "    set -l flags (_codemie_valueflags \"$argv[1]\" | string split -n ' ')",
      '    test (count $flags) -gt 0; or return 1',
      '    contains -- "$argv[2]" $flags',
      'end',
      '',
      'function __codemie_complete',
      '    set -l tokens (commandline -opc)',
      '    set -l n (count $tokens)',
      '    test $n -ge 1; or return 0',
      '',
      '    set -l cur (commandline -ct)',
      "    set -l cmd (string replace -r '^.*/' '' -- \"$tokens[1]\")",
      "    set -l path ''",
      '    set -l idx 0',
      '    set -l i 2',
      '',
      '    # Resolve the command path by consuming known subcommands.',
      '    while test $i -le $n',
      '        set -l w "$tokens[$i]"',
      '        set -l key "$cmd$path"',
      '        if test (count $w) -gt 0; and string match -q -r -- \'^-\' "$w"',
      '            if __codemie_has_valueflag "$key" "$w"',
      '                set i (math $i + 2)',
      '            else',
      '                set i (math $i + 1)',
      '            end',
      '            continue',
      '        end',
      "        set -l kids (_codemie_children \"$key\" | string split -n ' ')",
      '        if test (count $kids) -gt 0; and contains -- $w $kids',
      '            # Keep the leading space: "$cmd$path" builds the lookup key.',
      '            set path "$path $w"',
      '            set idx 0',
      '        else',
      '            set idx (math $idx + 1)',
      '        end',
      '        set i (math $i + 1)',
      '    end',
      '',
      '    set -l key "$cmd$path"',
      "    set -l prev ''",
      '    set prev "$tokens[$n]"',
      '',
      '    set -l cands',
      '    if test -n "$prev"; and string match -q -r -- \'^-\' "$prev"',
      '        # Value-taking flag with no candidate set: offer nothing.',
      '        if __codemie_has_valueflag "$key" "$prev"',
      "            set cands (_codemie_optvals \"$key\" \"$prev\" | string split -n ' ')",
      '        end',
      '    else if test (count $cur) -gt 0; and string match -q -r -- \'^-\' "$cur"',
      "        set cands (_codemie_flags \"$key\" | string split -n ' ')",
      '    else',
      "        set cands (_codemie_children \"$key\" | string split -n ' ')",
      "        set -a cands (_codemie_args \"$key\" \"$idx\" | string split -n ' ')",
      '    end',
      '',
      '    for c in $cands',
      '        test -n "$c"; and printf \'%s\\n\' "$c"',
      '    end',
      'end',
    ],
    [registrations]
  );
}
