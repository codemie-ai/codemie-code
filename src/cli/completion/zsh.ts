/** Zsh autoload completion generator. */
import { emitSpec } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

export function generateZsh(roots: RootTree[], candidates: CandidateMap): string {
  const names = roots.map((root) => root.command);
  if (names.some((name) => !/^[A-Za-z0-9._-]+$/.test(name))) {
    throw new Error('Invalid completion root name');
  }
  return [`#compdef ${names.join(' ')}`,
    emitSpec('posix', roots, candidates),
    `_codemie_dynamic() {
  local helper='__CODEMIE_COMPLETION_HELPER__'
  [[ -f "$helper" ]] || return 0
  case "$1" in profiles|plugins) node "$helper" "$1" 2>/dev/null ;; esac
}
_codemie_has_valueflag() {
  local flag
  while IFS= read -r flag; do [[ "$flag" == "$2" ]] && return 0; done < <(_codemie_valueflags "$1")
  return 1
}
_codemie_has_optionalflag() {
  local flag
  while IFS= read -r flag; do [[ "$flag" == "$2" ]] && return 0; done < <(_codemie_optionalflags "$1")
  return 1
}
_codemie_has_variadicflag() {
  local flag
  while IFS= read -r flag; do [[ "$flag" == "$2" ]] && return 0; done < <(_codemie_variadicflags "$1")
  return 1
}
local cmd cur prev key commandPath='' w child kind prefix='' valueflag='' activeflag=''
local -a cands
local idx=0 i=2
cmd="\${words[1]:t}"
cur="\${words[CURRENT]}"
prev=''
(( CURRENT > 1 )) && prev="\${words[CURRENT - 1]}"
while (( i < CURRENT )); do
  w="\${words[i]}"
  key="$cmd\${commandPath:+ $commandPath}"
  case "$w" in
    --*=*)
      activeflag="\${w%%=*}"
      _codemie_has_variadicflag "$key" "$activeflag" || activeflag=''
      (( i += 1 )); continue ;;
    -*)
      activeflag=''
      if _codemie_has_valueflag "$key" "$w"; then
        if _codemie_has_optionalflag "$key" "$w" && [[ "\${words[i + 1]}" == -* ]]; then
          (( i += 1 )); continue
        fi
        _codemie_has_variadicflag "$key" "$w" && activeflag="$w"
        (( i += 2 ))
      else (( i += 1 )); fi
      continue ;;
  esac
  if [[ -n "$activeflag" ]]; then (( i += 1 )); continue; fi
  child="$(_codemie_child "$key" "$w")"
  if [[ -n "$child" ]]; then commandPath="\${commandPath:+$commandPath }$child"; idx=0
  else (( idx += 1 )); fi
  (( i += 1 ))
done
key="$cmd\${commandPath:+ $commandPath}"
if [[ "$cur" == --*=* ]]; then
  valueflag="\${cur%%=*}"; prefix="$valueflag="; cur="\${cur#*=}"
elif _codemie_has_valueflag "$key" "$prev"; then
  if ! _codemie_has_optionalflag "$key" "$prev" || [[ "$cur" != -* ]]; then valueflag="$prev"; fi
elif [[ -n "$activeflag" && "$cur" != -* ]]; then
  valueflag="$activeflag"
fi
if [[ -n "$valueflag" ]] && _codemie_has_valueflag "$key" "$valueflag"; then
  kind="$(_codemie_opt_dynamic "$key" "$valueflag")"
  cands=("\${(@f)$(_codemie_optvals "$key" "$valueflag"; _codemie_dynamic "$kind")}")
elif [[ "$cur" == -* ]]; then
  cands=("\${(@f)$(_codemie_flags "$key")}")
else
  kind="$(_codemie_arg_dynamic "$key" "$idx")"
  cands=("\${(@f)$(_codemie_children "$key"; _codemie_args "$key" "$idx"; _codemie_dynamic "$kind")}")
fi
if (( \${#cands} )); then
  if [[ -n "$prefix" ]]; then compadd -P "$prefix" -- "$cands[@]"
  else compadd -- "$cands[@]"; fi
else
  _files
fi
`].join('\n');
}
