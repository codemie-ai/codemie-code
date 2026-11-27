DONE
Commit: a7e3e01f  (feat(cli): EPMCDME-17673 add bash completion emitter (shell-completions-plan task 4))

Changed: src/cli/completion/bash.ts (new), src/cli/completion/tree.ts (+effectiveOptions), src/cli/completion/__tests__/{bash.test.ts,tree.test.ts,__snapshots__/bash.test.ts.snap}, tests/helpers/completion-fixtures.ts (new), tests/integration/completion/bash.test.ts (new)

Tests: npx vitest run --project unit src/cli/completion ; npx vitest run --project cli tests/integration/completion  (all green; RED seen first for effectiveOptions and bash.ts)

Notes for zsh/fish authors:
- tree.ts: export function effectiveOptions(root: NodeModel, node: NodeModel): OptionModel[]  (node own options first, then root options not redeclared; dedupe by long OR short; for node===root returns copy of root.options). Use it for every node.
- Fixture: tests/helpers/completion-fixtures.ts exports buildFixtureRoot(): Command (root 'tool', list|ls with choices incl. 'two words', path opt --out, optional --cfg, free --name, hidden --secret/internal/zz, nested a>b>c). Model = buildModel(buildFixtureRoot()).
- Integration harness (bash.test.ts): emit script to tmp file, spawnSync('bash',['-c',HARNESS,'harness',script,'_tool',cword,...words]); gate: bash missing + CI=true => a throwing test; else describe.skip; win32 skip.
- bash.ts notes: escapeBash collapses newlines, so lists are built by escaping each item then joining with a real newline (qList). Value rule: required-value options only consume next word; optional-value options neither consume nor offer values.
