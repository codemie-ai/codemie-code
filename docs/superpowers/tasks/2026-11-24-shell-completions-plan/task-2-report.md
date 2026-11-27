DONE

Commit: e9f190bf
Changed: src/cli/completion/tree.ts, src/cli/completion/__tests__/tree.test.ts
Test cmd: npx vitest run --project unit src/cli/completion (7/7 pass; RED seen first: module missing)

Empirical root-option result: `node bin/codemie.js list --version` printed 0.17.1 (exit 0); `list --task x` was routed to the --task handler (src/cli/index.ts scans argv for --task anywhere; it then failed on model lookup, i.e. accepted). => Root options (--task, -V, --version) ARE accepted after subcommands: emitters must offer root options at every node. This contradicts the spec's "not inherited"; empirical rules. Recorded as a comment in tree.ts. buildModel keeps root options on the root node only; Task 3+ emitters must propagate them to all nodes. Docs (Task 10) must state this.

Interfaces (as implemented): ValueKind, OptionModel, NodeModel, buildModel(root: Command): NodeModel exactly per plan.
Notes: every node gets -h/--help; nodes with visible subs get an implicit 'help' sub (which itself has -h/--help); leaves get no help sub. valueKind 'path' when flags contain <path|file|dir> (or [..] optional form); choices from Option.argChoices.
