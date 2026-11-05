/**
 * Zsh completion script generator.
 */

import { emitSpec } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

function lines(parts: string[][]): string {
  return parts.flat().join('\n') + '\n';
}

export function generateZsh(roots: RootTree[], candidates: CandidateMap): string {
  const spec = emitSpec('posix', roots, candidates);
  const registrations = roots.map((root) => root.command).join(' ');

  return lines([
    ['# codemie shell completions (zsh)'],
    ['# Enable with:  source <(codemie completion zsh)'],
    [''],
    [spec],
    [
      '# True when flag $2 (on command path $1) consumes a value.',
      '_codemie_zsh_has_valueflag() {',
      '  local _f',
      '  for _f in $(_codemie_valueflags "$1"); do',
      '    [[ "$_f" == "$2" ]] && return 0',
      '  done',
      '  return 1',
      '}',
      '',
      '_codemie_zsh_complete() {',
      '  local cmd cur prev key path w kids acands',
      '  local idx=0 i=2',
      '  local -a cands kids_arr',
      '  cmd="${words[1]:t}"',
      '  cur="${words[CURRENT]}"',
      '  prev=""',
      '  (( CURRENT > 1 )) && prev="${words[CURRENT - 1]}"',
      '',
      '  while (( i < CURRENT )); do',
      '    w="${words[i]}"',
      '    key="$cmd${path:+ $path}"',
      '    if [[ "$w" == -* ]]; then',
      '      if _codemie_zsh_has_valueflag "$key" "$w"; then (( i += 2 )); else (( i += 1 )); fi',
      '      continue',
      '    fi',
      '    kids_arr=( $(_codemie_children "$key") )',
      '    if (( ${kids_arr[(I)$w]} )); then',
      '      path="${path:+$path }$w"',
      '      idx=0',
      '      (( i += 1 ))',
      '      continue',
      '    fi',
      '    (( idx += 1 ))',
      '    (( i += 1 ))',
      '  done',
      '',
      '  key="$cmd${path:+ $path}"',
      '',
      '  if [[ -n "$prev" && "$prev" == -* ]] && _codemie_zsh_has_valueflag "$key" "$prev"; then',
      '    cands=( $(_codemie_optvals "$key" "$prev") )',
      '  elif [[ "$cur" == -* ]]; then',
      '    cands=( $(_codemie_flags "$key") )',
      '  else',
      '    cands=( $(_codemie_children "$key") $(_codemie_args "$key" "$idx") )',
      '  fi',
      '',
      '  if (( ${#cands} )); then',
      '    compadd -Q -- "${cands[@]}"',
      '  else',
      '    _files',
      '  fi',
      '}',
      '',
      '# compdef is defined by compinit; make sure it is available.',
      '(( $+functions[compdef] )) || { autoload -Uz compinit && compinit -i }',
      `compdef _codemie_zsh_complete ${registrations}`,
    ],
  ]);
}
