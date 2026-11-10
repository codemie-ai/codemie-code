/** Bash 3-compatible completion generator, one autoload file per root. */
import { emitSpec, rootNamespace } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

export function generateBash(roots: RootTree[], candidates: CandidateMap): string {
  if (roots.length !== 1) throw new Error('Bash completion requires exactly one root');
  const root = roots[0];
  const namespace = `_codemie_${rootNamespace(root.command)}`;
  const spec = emitSpec('posix', roots, candidates, namespace);
  const script = `_codemie_dynamic() {
  local helper='__CODEMIE_COMPLETION_HELPER__'
  [ -f "$helper" ] || return 0
  case "$1" in profiles|plugins) node "$helper" "$1" 2>/dev/null ;; esac
}
_codemie_has_valueflag() {
  local flag
  while IFS= read -r flag; do [ "$flag" = "$2" ] && return 0; done < <(_codemie_valueflags "$1")
  return 1
}
_codemie_has_optionalflag() {
  local flag
  while IFS= read -r flag; do [ "$flag" = "$2" ] && return 0; done < <(_codemie_optionalflags "$1")
  return 1
}
_codemie_has_variadicflag() {
  local flag
  while IFS= read -r flag; do [ "$flag" = "$2" ] && return 0; done < <(_codemie_variadicflags "$1")
  return 1
}
_codemie_reply() {
  local candidate="$1" raw="\${COMP_WORDS[COMP_CWORD]}"
  # Readline chooses double quotes for expansions even with -o filenames, so
  # protect expansion characters before handing it the candidate.
  case "$raw" in
    \\'*) ;;
    *)
      # Bash 3's Readline already escapes expansions; newer Bash can insert
      # them inside double quotes without escaping.
      case "$candidate" in
        *'$'*|*'\`'*)
          [ "\${BASH_VERSINFO[0]}" -ge 4 ] || { COMPREPLY+=("$candidate"); return; }
          candidate="\${candidate//\\\\/\\\\\\\\}"
          candidate="\${candidate//$/\\\\$}"
          candidate="\${candidate//\\\`/\\\\\\\`}"
          ;;
      esac ;;
  esac
  COMPREPLY+=("$candidate")
}
_codemie_complete() {
  local cmd cur prev key path='' w child kind candidate prefix='' valueflag='' activeflag=''
  local idx=0 i=1
  COMPREPLY=()
  cmd="\${COMP_WORDS[0]##*/}"
  cur="\${COMP_WORDS[COMP_CWORD]}"
  # COMP_WORDS retains an opening quote, while Readline handles quoting replies.
  case "$cur" in
    \\"*) cur="\${cur#\\"}" ;;
    \\'*) cur="\${cur#\\'}" ;;
  esac
  prev=''
  [ "$COMP_CWORD" -gt 0 ] && prev="\${COMP_WORDS[$((COMP_CWORD - 1))]}"
  while [ "$i" -lt "$COMP_CWORD" ]; do
    w="\${COMP_WORDS[$i]}"
    key="$cmd\${path:+ $path}"
    case "$w" in
      --*=*)
        activeflag="\${w%%=*}"
        _codemie_has_variadicflag "$key" "$activeflag" || activeflag=''
        i=$((i + 1)); continue ;;
      -*)
        activeflag=''
        if _codemie_has_valueflag "$key" "$w"; then
          if _codemie_has_optionalflag "$key" "$w" && [[ "\${COMP_WORDS[$((i + 1))]}" = -* ]]; then
            i=$((i + 1)); continue
          fi
          _codemie_has_variadicflag "$key" "$w" && activeflag="$w"
          if [ "\${COMP_WORDS[$((i + 1))]}" = '=' ]; then i=$((i + 3)); else i=$((i + 2)); fi
        else i=$((i + 1)); fi
        continue ;;
    esac
    if [ -n "$activeflag" ]; then i=$((i + 1)); continue; fi
    child="$(_codemie_child "$key" "$w")"
    if [ -n "$child" ]; then path="\${path:+$path }$child"; idx=0
    else idx=$((idx + 1)); fi
    i=$((i + 1))
  done
  key="$cmd\${path:+ $path}"
  case "$cur" in
    --*=*) valueflag="\${cur%%=*}"; prefix="$valueflag="; cur="\${cur#*=}" ;;
  esac
  if [ -z "$valueflag" ] && [ "$prev" = '=' ] && [ "$COMP_CWORD" -ge 2 ]; then
    valueflag="\${COMP_WORDS[$((COMP_CWORD - 2))]}"
  elif [ -z "$valueflag" ] && _codemie_has_valueflag "$key" "$prev"; then
    if ! _codemie_has_optionalflag "$key" "$prev" || [[ "$cur" != -* ]]; then valueflag="$prev"; fi
  elif [ -z "$valueflag" ] && [ -n "$activeflag" ] && [[ "$cur" != -* ]]; then
    valueflag="$activeflag"
  fi
  if [ -n "$valueflag" ] && _codemie_has_valueflag "$key" "$valueflag"; then
    kind="$(_codemie_opt_dynamic "$key" "$valueflag")"
    while IFS= read -r candidate; do
      case "$candidate" in "$cur"*) _codemie_reply "$prefix$candidate" ;; esac
    done < <(_codemie_optvals "$key" "$valueflag"; _codemie_dynamic "$kind")
  elif [ "\${cur#-}" != "$cur" ]; then
    while IFS= read -r candidate; do
      case "$candidate" in "$cur"*) _codemie_reply "$candidate" ;; esac
    done < <(_codemie_flags "$key")
  else
    kind="$(_codemie_arg_dynamic "$key" "$idx")"
    while IFS= read -r candidate; do
      case "$candidate" in "$cur"*) _codemie_reply "$candidate" ;; esac
    done < <(_codemie_children "$key"; _codemie_args "$key" "$idx"; _codemie_dynamic "$kind")
  fi
}
complete -o default -o bashdefault -o filenames -F _codemie_complete '${root.command.replace(/'/g, "'\\''")}'
`;
  return `# codemie shell completions (bash)\n${spec}\n${script.replace(/_codemie/g, namespace)}`;
}
