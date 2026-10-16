/**
 * Bash completion script generator.
 */

import { emitSpec } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

function lines(...parts: string[][]): string {
  return parts.flat().join('\n') + '\n';
}

export function generateBash(roots: RootTree[], candidates: CandidateMap): string {
  const spec = emitSpec('posix', roots, candidates);
  const registrations = roots
    .map((root) => `complete -o default -o bashdefault -F _codemie_bash_complete ${root.command}`)
    .join('\n');

  return lines(
    ['# codemie shell completions (bash)'],
    ['# Enable with:  source <(codemie completion bash)'],
    [''],
    [spec],
    [
      '# True when flag $2 (on command path $1) consumes a value.',
      '_codemie_bash_has_valueflag() {',
      '  local _f',
      '  for _f in $(_codemie_valueflags "$1"); do',
      '    [ "$_f" = "$2" ] && return 0',
      '  done',
      '  return 1',
      '}',
      '',
      '_codemie_bash_complete() {',
      '  local cmd cword cur prev key path w kids acands cands',
      '  local idx=0 i=1',
      '  cmd="${COMP_WORDS[0]##*/}"',
      '  cword=$COMP_CWORD',
      '  cur="${COMP_WORDS[COMP_CWORD]}"',
      '  prev=""',
      '  [ "$cword" -gt 0 ] && prev="${COMP_WORDS[$((cword - 1))]}"',
      '',
      '  while [ "$i" -lt "$cword" ]; do',
      '    w="${COMP_WORDS[$i]}"',
      '    key="$cmd${path:+ $path}"',
      '    if [ "${w#-}" != "$w" ]; then',
      '      if _codemie_bash_has_valueflag "$key" "$w"; then i=$((i + 2)); else i=$((i + 1)); fi',
      '      continue',
      '    fi',
      '    kids="$(_codemie_children "$key")"',
      '    case " $kids " in',
      '      *" $w "*) path="${path:+$path }$w"; idx=0; i=$((i + 1)); continue ;;',
      '    esac',
      '    idx=$((idx + 1))',
      '    i=$((i + 1))',
      '  done',
      '',
      '  key="$cmd${path:+ $path}"',
      '',
      '  if [ -n "$prev" ] && [ "${prev#-}" != "$prev" ] && _codemie_bash_has_valueflag "$key" "$prev"; then',
      '    cands="$(_codemie_optvals "$key" "$prev")"',
      '    COMPREPLY=( $(compgen -W "$cands" -- "$cur") )',
      '    return 0',
      '  fi',
      '',
      '  if [ "${cur#-}" != "$cur" ]; then',
      '    cands="$(_codemie_flags "$key")"',
      '    COMPREPLY=( $(compgen -W "$cands" -- "$cur") )',
      '    return 0',
      '  fi',
      '',
      '  kids="$(_codemie_children "$key")"',
      '  acands="$(_codemie_args "$key" "$idx")"',
      '  cands="$kids $acands"',
      '  COMPREPLY=( $(compgen -W "$cands" -- "$cur") )',
      '  return 0',
      '}',
    ],
    [registrations]
  );
}
