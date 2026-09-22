# Technical Research

**Task**: Remove duplicate `codemie sdk workflows run` command surface
**Generated**: 2026-09-22
**Research path**: filesystem

## 1. Original Context

The ticket removes the redundant SDK workflow execution command while preserving `codemie workflow run` as the sole workflow execution entrypoint. The global command must retain ID/name resolution, input parsing, optional file upload, polling, interrupted execution decisions, JSON output, and final rendering. No SDK service contract or global command behavior should change.

## 2. Codebase Findings

### 2.1 CLI registration and architecture

- `src/cli/index.ts:22,35,90` registers both `createWorkflowCommand()` and `createSdkCommand()`, so the two surfaces are independently exposed at the CLI layer.
- `src/cli/commands/sdk/index.ts:18-25` keeps the SDK resource group and adds `createWorkflowsSubcommand()`; removing only its `run` child preserves SDK list/get/create/update/delete commands.
- `src/cli/commands/sdk/workflows.ts:40` defines the `sdk workflows` Commander command. Its `run <id>` block is `:253-477` and duplicates the execution orchestration.
- `src/cli/commands/workflow.ts:442-692` is the canonical `workflow run [workflow-id-or-name]` implementation and should remain unchanged.

### 2.2 Shared service and imports

- `src/cli/commands/sdk/services/workflows.ts:70-78` exports `runWorkflow`, a thin wrapper around `client.workflows.run()`.
- The global command imports and calls `runWorkflow` at `src/cli/commands/workflow.ts:25,529`; therefore the service must remain.
- In `src/cli/commands/sdk/workflows.ts`, `fs` (`:1`), `path` (`:2`), `inquirer` (`:6`), and `runWorkflow` (`:18`) are used only by the SDK `run` block and become removable. `listWorkflows` remains required by SDK `list`.

## 3. Recommended Implementation Shape

Delete only the SDK `run <id>` command block and its run-only imports from `src/cli/commands/sdk/workflows.ts`. Do not extract a helper and do not modify `src/cli/commands/workflow.ts` or the `runWorkflow` service. Preserve the SDK workflows command's remaining CRUD surface and the global command's existing options: `--workflow`, `--input`, `--file`, `--no-wait`, and `--json`.

## 4. Testing Landscape

`tests/integration/cli-commands/workflow.test.ts:41-68` is the direct affected test. Rename the suite to describe only the global workflow-run command, remove the expectation that `sdk workflows run --help` succeeds, and retain coverage for global help options and the missing workflow ID/name error. A focused negative/help assertion for the removed SDK child may be added if the existing CLI runner makes unknown-command behavior stable, but no global execution assertions should be weakened.

## 5. Documentation and Help Findings

No canonical `README.md`, `docs/COMMANDS.md`, or `docs/EXAMPLES.md` reference to `sdk workflows run` was found. Commander help is generated from `src/cli/commands/sdk/workflows.ts`; deleting the block removes its help automatically. Historical generated artifacts under `docs/superpowers/tasks/2026-09-08-epmcdme-12353-run-shared-custom-workflows/` mention the old command, but they are prior-run evidence and should not be rewritten as part of this source change unless explicitly requested.

## 6. Risk Indicators

- **Behavioral regression risk**: deleting more than lines `253-477` could affect SDK CRUD commands; keep the change bounded to the child command and its run-only imports.
- **Accidental service removal**: `runWorkflow` appears unused in the SDK command after deletion but remains required by the global command.
- **Help/test mismatch**: the existing integration test explicitly expects SDK run help to succeed and must be updated; otherwise the intended removal will appear as a failure.
- **Global behavior drift**: the global implementation duplicates the same logic but is the supported surface; avoid “cleanup” edits there because the task requires behavior preservation.
- **Generated/history references**: prior task documents contain the removed form but are not canonical product documentation.

## 7. Summary for Complexity Assessment

This is a low-complexity CLI-surface deletion with one production source file and one direct integration test affected. The implementation should remove the `run` Commander child and four run-only imports from `src/cli/commands/sdk/workflows.ts`, retain `runWorkflow` because `src/cli/commands/workflow.ts` still consumes it, and update the workflow CLI test to assert only the canonical command/help contract. No registry, provider, SDK service, package, or architecture changes are indicated. The principal verification points are that `sdk workflows` still exposes list/get/create/update/delete, `sdk workflows run` no longer resolves, and `workflow run` retains all existing options and orchestration. Do not edit historical task artifacts, run tests, or change unrelated workflow documentation.
