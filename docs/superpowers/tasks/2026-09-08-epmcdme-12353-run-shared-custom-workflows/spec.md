# EPMCDME-12353 — Run Shared or Custom Workflows from CodeMie CLI

## Problem

CodeMie CLI manages various AI assets, including workflows. While it allows listing, creating, and deleting workflows, it lacks a mechanism to trigger/run workflows directly from the CLI. This prevents developers and automations from executing custom or shared workflows from terminal-based or IDE-integrated environments.

## Solution

We will extend CodeMie CLI to support executing workflows in two user-friendly ways:
1. **Top-Level `codemie run` Command:** Intuitive and easy for standard users to trigger custom or shared workflows directly.
2. **SDK Subcommand `codemie sdk workflows run`:** Highly consistent with other SDK subcommands for developers managing workflows.

Both commands will support:
- Workflow identification by **ID** (e.g., `wfl_abc123`) or **Name** (e.g., `"My Custom Workflow"`).
- Accepting variable inputs or parameters via `--input` flag (accepts string or inline JSON).
- Specifying custom files via `--file` flag and custom session IDs via `--session` flag.
- Output formatting via `--json` flag to print the raw execution response.

## Scope

**In Scope**
- `runWorkflow` service function in `src/cli/commands/sdk/services/workflows.ts` that delegates to CodeMie SDK's `client.workflows.run(...)` method.
- Top-level `codemie run [workflow-id-or-name]` command in `src/cli/commands/run.ts`, registered in `src/cli/index.ts`.
- Subcommand `codemie sdk workflows run <workflow-id-or-name>` in `src/cli/commands/sdk/workflows.ts`.
- Case-insensitive Name-to-ID resolution for user workflows when a non-ID string is supplied.
- Robust parsing of the `--input` flag, accepting strings or structured JSON parameters.
- Comprehensive vitest integration tests under `tests/integration/cli-commands/workflow.test.ts`.

**Out of Scope**
- Executing workflows that the user does not have permission to access.
- Non-CLI triggers or UI components for running workflows.

## Design

### Workflow Resolution Flow:
1. The user provides a target string (e.g., `wfl_abc123` or `"PR Review"`).
2. If the string starts with `wfl_`, it is assumed to be an ID and used directly.
3. Otherwise, the CLI calls `listWorkflows` with the `search` filter equal to the target string.
4. From the returned workflows:
   - If there is an exact case-insensitive match on the `name` field, use that workflow's ID.
   - If no exact name match is found but there's only one workflow in the list, use that workflow's ID.
   - Otherwise, throw a clear error identifying the ambiguity or absence of the workflow.

### Input Variable Parsing:
- If `--input` is provided:
  - Try parsing it as a JSON object using `JSON.parse`.
  - If parsing fails, treat it as a plain string.
  - Pass the resolved value to the SDK `run` method's `userInput` parameter.

## Test Strategy

We will add integration tests under `tests/integration/cli-commands/workflow.test.ts` to cover the new features:
1. **Command registration:** Verify `codemie run --help` and `codemie sdk workflows run --help` display accurate descriptions and options.
2. **Workflow Execution & ID Lookup:** Mock the SDK client's `workflows.get` and `workflows.list` methods to return dummy workflows, then verify that executing by ID and by name correctly resolves the target ID and executes the workflow with custom inputs.

## Acceptance Criteria

- [ ] CLI provides `codemie run <id-or-name>` to run accessible workflows.
- [ ] CLI provides `codemie sdk workflows run <id-or-name>` to run accessible workflows.
- [ ] Both commands support `--input` (variables), `--file` (associated file), and `--session` (session ID).
- [ ] Both commands support `--json` to output execution details in JSON format.
- [ ] Resolution by name is case-insensitive.
- [ ] No regression for existing CLI commands.
