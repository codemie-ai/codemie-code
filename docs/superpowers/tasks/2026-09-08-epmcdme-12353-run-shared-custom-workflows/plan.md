# EPMCDME-12353 Run Shared or Custom Workflows — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `codemie run` command and `codemie sdk workflows run` subcommand to execute custom or shared workflows by ID or name with variables/parameters, file parameters, and custom session IDs.

**Architecture:**
- **Core service extension:** Add `runWorkflow` to `src/cli/commands/sdk/services/workflows.ts`.
- **Subcommand extension:** Add `run` to the `workflows` subcommand collection in `src/cli/commands/sdk/workflows.ts` with ID/Name lookup and input parsing.
- **Top-level command:** Create `src/cli/commands/run.ts` to expose `codemie run [workflow-id-or-name] [options]`.
- **Main CLI entrypoint registration:** Register the new `run` command in `src/cli/index.ts`.
- **Integration tests:** Add comprehensive CLI tests in `tests/integration/cli-commands/workflow.test.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/cli/commands/sdk/services/workflows.ts` | Extends workflow services with `runWorkflow` wrapper calling the SDK's `client.workflows.run`. |
| `src/cli/commands/sdk/workflows.ts` | Implements the `run` subcommand under `codemie sdk workflows run <id-or-name>`. |
| `src/cli/commands/run.ts` | Implements the top-level `codemie run [workflow-id-or-name]` command. |
| `src/cli/index.ts` | Registers the top-level `run` command. |
| `tests/integration/cli-commands/workflow.test.ts` | Contains integration tests validating the CLI commands, input parsing, name resolution, and execution. |

---

## Tasks

### Task 1: Extend Workflow Services with `runWorkflow`
**File:** `src/cli/commands/sdk/services/workflows.ts`
**Test-first: yes** — A new unit/integration test verifying that calling `runWorkflow` invokes the underlying SDK method `client.workflows.run` with correct arguments and resolves with the response.
- [ ] **Step 1:** Implement the `runWorkflow` function in `src/cli/commands/sdk/services/workflows.ts` to forward calls to `client.workflows.run`.

---

### Task 2: Implement the `workflows run` Subcommand
**File:** `src/cli/commands/sdk/workflows.ts`
**Test-first: yes — A failing integration test verifying `codemie sdk workflows run wfl_abc123` executes the workflow with --input / --file / --session / --json options.**
- [ ] **Step 1:** Import `runWorkflow` from `./services/workflows.js` and add a new `.command("run <id>")` definition under `createWorkflowsSubcommand()`.
- [ ] **Step 2:** Implement name lookup logic: if `id` does not start with `wfl_`, call `listWorkflows(client, { search: id })`, resolve by matching `name` exactly (case-insensitive) or `id`, and handle ambiguity or absence.
- [ ] **Step 3:** Implement input parsing (parsing `--input` as JSON object if possible, otherwise passing as string) and invoke `runWorkflow`.
- [ ] **Step 4:** Render output successfully based on options: format and log execution payload as JSON if `--json` or execution succeeds.

---

### Task 3: Implement the Top-Level `run` Command
**File:** `src/cli/commands/run.ts`
**Test-first: yes — A failing integration test verifying that `codemie run wfl_abc123` triggers workflow execution with option parsing and ID resolution.**
- [ ] **Step 1:** Create `src/cli/commands/run.ts` defining `createRunCommand()`.
- [ ] **Step 2:** Support both argument `[workflow-id-or-name]` and option `--workflow <id-or-name>`.
- [ ] **Step 3:** Implement name resolution, `--input` parsing, and SDK client execution logic identical to Task 2.
- [ ] **Step 4:** Document the options and provide descriptive usage examples in help text.

---

### Task 4: Register the Top-Level `run` Command
**File:** `src/cli/index.ts`
**Test-first: yes — A failing integration test verifying `codemie run --help` executes and lists the run command in command documentation.**
- [ ] **Step 1:** Import `createRunCommand` in `src/cli/index.ts`.
- [ ] **Step 2:** Register the run command with `program.addCommand(createRunCommand());`.

---

### Task 5: Add CLI Integration and Regression Tests
**File:** `tests/integration/cli-commands/workflow.test.ts`
**Test-first: yes** — Writing failing integration tests in `tests/integration/cli-commands/workflow.test.ts` to assert:
- `codemie run --help` lists the run command.
- Executing with no workflow ID/name exits with code 1 and prints an error.
- Mocking the workflow endpoints to assert correct input forwarding, name-to-ID resolution, option handling, and output formatting.
- [ ] **Step 1:** Update `tests/integration/cli-commands/workflow.test.ts` to add integration tests validating our new command lines.
