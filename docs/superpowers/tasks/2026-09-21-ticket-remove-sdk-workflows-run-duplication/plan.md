## Acceptance criteria

- [ ] `codemie sdk workflows run` is no longer registered or accepted.
- [ ] `codemie sdk workflows` still exposes the SDK CRUD commands: `list`, `get`, `create`, `update`, and `delete`.
- [ ] `codemie workflow run` remains the sole workflow execution entrypoint and still resolves workflows by ID or name.
- [ ] The global command still advertises and accepts `--input`, `--file`, `--no-wait`, and `--json` (as well as its existing `--workflow` alternative).
- [ ] The global workflow execution orchestration and `runWorkflow` SDK service contract are unchanged.
- [ ] Integration/help expectations describe the removed SDK run surface without weakening existing global workflow-run coverage.
- [ ] Historical task artifacts and generated evidence are not rewritten.

# Remove duplicate SDK workflow-run command — Implementation Plan

> **For agentic workers:** Implement the tasks in order. Use the repository's existing Vitest integration-test patterns and do not commit or push as part of this task.

**Goal:** Remove only the redundant `sdk workflows run` Commander child command and its run-only imports while preserving SDK workflow CRUD and the canonical global workflow execution command.

**Architecture:** Keep the change at the CLI registration layer. `src/cli/commands/sdk/workflows.ts` will retain only SDK CRUD command registration, while `src/cli/commands/workflow.ts` remains the unchanged global orchestration path and continues to consume `runWorkflow` from the SDK service layer. No new helper or service abstraction is introduced.

**Tech Stack:** TypeScript ES modules, Commander, Vitest CLI integration tests, the existing `tests/helpers/cli-runner.ts` runner.

**Spec:** `ticket-remove-sdk-workflows-run-duplication.md`; research: `docs/superpowers/tasks/2026-09-21-ticket-remove-sdk-workflows-run-duplication/technical-analysis.md`.

## Global constraints

- Modify only the SDK workflow command registration and directly affected integration/help expectations.
- Remove the SDK `run <id>` child command; do not extract or rewrite its orchestration.
- Keep `src/cli/commands/workflow.ts` byte-for-behavior unchanged.
- Keep `src/cli/commands/sdk/services/workflows.ts::runWorkflow`; it remains imported by the global command.
- Do not change SDK service contracts, registry wiring, provider behavior, or unrelated workflow documentation.
- Do not rewrite historical artifacts under prior task directories.
- Do not add unrelated tests.
- Do not commit or push.

## Review focus

- Removed command invocation: `sdk workflows run --help` must return a non-zero exit code instead of resolving a help page.
- SDK CRUD registration: `sdk workflows --help` must still list `list`, `get`, `create`, `update`, and `delete`, and must not list `run`.
- Global option surface: `workflow run --help` must retain `--workflow`, `--input`, `--file`, `--no-wait`, and `--json`.
- Global argument validation: `workflow run` without an ID/name or `--workflow` must retain its existing error and exit code.
- Service ownership: `runWorkflow` must remain available to `src/cli/commands/workflow.ts`; no service deletion or contract change is allowed.

### Task 1: Update integration and help expectations for the canonical command surface

**Files:**
- Modify: `tests/integration/cli-commands/workflow.test.ts`
- Do not modify: `src/cli/commands/workflow.ts`, `src/cli/commands/sdk/services/workflows.ts`

**Interfaces:**
- Consumes: `createCLIRunner().runSilent()` and `CommandResult` from `tests/helpers/cli-runner.ts`.
- Produces: executable CLI expectations that fail against the current registered SDK `run` command and pass once that command is removed.

**Test-first: yes — the new negative assertion for `sdk workflows run --help` must fail while the current SDK run child is still registered.**

- [ ] **Step 1: Replace the duplicated-suite wording and positive SDK-run help expectation**

  Rename `describe('Workflow Run and Workflows Run commands', ...)` to describe the canonical global workflow-run command only. Remove the test that requires `sdk workflows run --help` to exit successfully and show execution options.

- [ ] **Step 2: Add the failing negative/help contract**

  Add a focused assertion for the removed surface and preserve the SDK CRUD help contract:

  ```typescript
  it('should reject the removed sdk workflows run command', () => {
    const result = cli.runSilent('sdk workflows run --help');
    expect(result.exitCode).not.toBe(0);
  });

  it('should keep sdk workflow CRUD commands in help', () => {
    const result = cli.runSilent('sdk workflows --help');
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('list');
    expect(result.output).toContain('get');
    expect(result.output).toContain('create');
    expect(result.output).toContain('update');
    expect(result.output).toContain('delete');
    expect(result.output).not.toMatch(/\brun\b/);
  });
  ```

  The negative assertion is intentionally expected to fail before the production command removal. The CRUD assertion ensures deleting the child does not remove the parent SDK resource group or its remaining commands.

- [ ] **Step 3: Preserve and strengthen the global help assertion**

  Keep the existing `workflow run --help` test and its checks for `--workflow`, `--input`, `--file`, and `--no-wait`. Add the existing `--json` option to the expected help text:

  ```typescript
  expect(result.output).toContain('--json');
  ```

  Keep the existing missing-workflow test unchanged so the global command's required ID/name validation remains covered.

- [ ] **Step 4: Run the focused CLI test to verify the new test is red**

  Run:

  ```bash
  npx vitest run --project cli tests/integration/cli-commands/workflow.test.ts
  ```

  Expected: the new `should reject the removed sdk workflows run command` test fails because the current SDK child still accepts `--help`; the existing global workflow tests continue to express their current behavior.

### Task 2: Remove the SDK run child and only its run-only imports

**Files:**
- Modify: `src/cli/commands/sdk/workflows.ts:1-25,253-477` (current ranges)
- Verify unchanged: `src/cli/commands/workflow.ts:1-692`
- Verify unchanged: `src/cli/commands/sdk/services/workflows.ts:70-78`
- Test: `tests/integration/cli-commands/workflow.test.ts` from Task 1

**Interfaces:**
- Consumes: the existing `createWorkflowsSubcommand()` Commander parent and SDK CRUD service imports.
- Produces: a `workflows` command that registers only `list`, `get`, `create`, `update`, and `delete`; the global command continues to use `runWorkflow(client, targetId, userInput, uploadedFileName, undefined)`.

**Test-first: yes — make the failing `sdk workflows run --help` rejection test pass by removing the registered child, without changing global workflow execution.**

- [ ] **Step 1: Delete exactly the SDK `run <id>` Commander block**

  Remove the `cmd.command("run <id>")` declaration and its complete action body, including its ID/name resolution, input parsing, file upload, polling, interrupted-execution prompts, resume/abort handling, and final rendering. Do not move this code into another file; the global implementation already owns the supported behavior.

- [ ] **Step 2: Remove only imports made unused by that deletion**

  From `src/cli/commands/sdk/workflows.ts`, remove:

  ```typescript
  import { promises as fs } from "node:fs";
  import path from "node:path";
  import inquirer from "inquirer";
  ```

  Remove `runWorkflow` from the `./services/workflows.js` import while retaining `listWorkflows`, `getWorkflow`, `createWorkflow`, `updateWorkflow`, and `deleteWorkflow`. Keep all imports still used by SDK CRUD commands, including `Command`, `chalk`, `ora`, render helpers, and SDK workflow types.

- [ ] **Step 3: Verify the service and global command were not altered**

  Confirm that:

  ```typescript
  // src/cli/commands/workflow.ts
  import { listWorkflows, runWorkflow } from './sdk/services/workflows.js';
  ```

  remains present and that the global `run [workflow-id-or-name]` options remain `--workflow`, `--input`, `--file`, `--no-wait`, and `--json`. Do not edit either `workflow.ts` or `sdk/services/workflows.ts`.

- [ ] **Step 4: Run the focused CLI test to verify the contract is green**

  Run:

  ```bash
  npx vitest run --project cli tests/integration/cli-commands/workflow.test.ts
  ```

  Expected: all workflow integration/help tests pass; `sdk workflows run --help` is rejected, SDK CRUD help remains available, global help retains all required options, and `workflow run` without an identifier retains exit code `1` and its existing error.

- [ ] **Step 5: Run non-test quality checks for the bounded source change**

  Run:

  ```bash
  npm run typecheck
  npm run lint
  npm run build
  ```

  Expected: all commands exit successfully, with no unused-import diagnostics, type errors, lint warnings, or build failures.

## Final verification checklist

- Inspect the final diff and confirm only `src/cli/commands/sdk/workflows.ts` and `tests/integration/cli-commands/workflow.test.ts` changed.
- Confirm `src/cli/commands/sdk/workflows.ts` contains no `cmd.command("run <id>")`, `runWorkflow`, `fs`, `path`, or `inquirer` references.
- Confirm `src/cli/commands/workflow.ts` and `src/cli/commands/sdk/services/workflows.ts` are unchanged.
- Confirm no historical task artifact or generated evidence file was edited.
- Do not commit or push.
