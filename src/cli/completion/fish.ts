/** Fish completion generator, one autoload file per root. */
import { emitSpec, rootNamespace } from './spec.js';
import type { CandidateMap, RootTree } from './types.js';

export function generateFish(roots: RootTree[], candidates: CandidateMap): string {
  if (roots.length !== 1) throw new Error('Fish completion requires exactly one root');
  const root = roots[0];
  if (!/^[A-Za-z0-9._-]+$/.test(root.command)) throw new Error('Invalid completion root name');
  const namespace = `_codemie_${rootNamespace(root.command)}`;
  const spec = emitSpec('fish', roots, candidates, namespace);
  const script = `function _codemie_dynamic
    set -l helper '__CODEMIE_COMPLETION_HELPER__'
    test -f "$helper"; or return 0
    switch "$argv[1]"
        case profiles plugins
            node "$helper" "$argv[1]" 2>/dev/null
    end
end
function _codemie_has_valueflag
    contains -- "$argv[2]" (_codemie_valueflags "$argv[1]")
end
function _codemie_has_optionalflag
    contains -- "$argv[2]" (_codemie_optionalflags "$argv[1]")
end
function _codemie_has_variadicflag
    contains -- "$argv[2]" (_codemie_variadicflags "$argv[1]")
end
function _codemie_complete
    set -l tokens (commandline -opc)
    set -l n (count $tokens)
    test $n -ge 1; or return 0
    set -l cur (commandline -ct)
    set -l cmd (string replace -r '^.*/' '' -- "$tokens[1]")
    set -l path ''
    set -l idx 0
    set -l activeflag ''
    set -l i 2
    while test $i -le $n
        set -l w "$tokens[$i]"
        set -l key "$cmd$path"
        if string match -q -- '--*=*' "$w"
            set activeflag (string replace -r '=.*$' '' -- "$w")
            _codemie_has_variadicflag "$key" "$activeflag"; or set activeflag ''
            set i (math $i + 1)
            continue
        else if string match -q -- '-*' "$w"
            set activeflag ''
            if _codemie_has_valueflag "$key" "$w"
                if _codemie_has_optionalflag "$key" "$w"; and test $i -lt $n; and string match -q -- '-*' "$tokens[(math $i + 1)]"
                    set i (math $i + 1)
                    continue
                end
                _codemie_has_variadicflag "$key" "$w"; and set activeflag "$w"
                set i (math $i + 2)
            else
                set i (math $i + 1)
            end
            continue
        end
        if test -n "$activeflag"
            set i (math $i + 1)
            continue
        end
        set -l child (_codemie_child "$key" "$w")
        if test (count $child) -gt 0
            set path "$path $child"
            set idx 0
        else
            set idx (math $idx + 1)
        end
        set i (math $i + 1)
    end
    set -l key "$cmd$path"
    set -l prev "$tokens[$n]"
    set -l valueflag ''
    set -l prefix ''
    if string match -q -- '--*=*' "$cur"
        set valueflag (string replace -r '=.*$' '' -- "$cur")
        set prefix "$valueflag="
    else if _codemie_has_valueflag "$key" "$prev"
        if not _codemie_has_optionalflag "$key" "$prev"; or not string match -q -- '-*' "$cur"
            set valueflag "$prev"
        end
    else if test -n "$activeflag"; and not string match -q -- '-*' "$cur"
        set valueflag "$activeflag"
    end
    set -l cands
    if test -n "$valueflag"; and _codemie_has_valueflag "$key" "$valueflag"
        set -l kind (_codemie_opt_dynamic "$key" "$valueflag")
        set cands (_codemie_optvals "$key" "$valueflag")
        if test (count $kind) -gt 0
            set -a cands (_codemie_dynamic "$kind")
        end
    else if string match -q -- '-*' "$cur"
        set cands (_codemie_flags "$key")
    else
        set -l kind (_codemie_arg_dynamic "$key" "$idx")
        set cands (_codemie_children "$key") (_codemie_args "$key" "$idx")
        if test (count $kind) -gt 0
            set -a cands (_codemie_dynamic "$kind")
        end
    end
    for candidate in $cands
        printf '%s%s\n' "$prefix" "$candidate"
    end
end
complete -c '${root.command}' -a '(_codemie_complete)'
`;
  return `# codemie shell completions (fish)\n${spec}\n${script.replace(/_codemie/g, namespace)}`;
}
